// 「解析一页」的实现：拼消息 → 调上游 → 抢救 JSON → 规范化。
//
// 全部在浏览器里跑：教师填自己的 DeepSeek 密钥，请求从浏览器直达上游，
// 密钥与费用都不经过本站（官方 API 支持跨域，已实测）。调用方是
// lib/import-parse-client.js；回写数据库由它用 RPC 完成。
//
// 这里不读环境变量、不碰 Node API（没有纯函数测试之外的服务端用法）。

import { SYSTEM_PROMPT, ANSWER_SYSTEM_PROMPT, buildPageParts, buildAnswerParts } from "@/lib/import-prompts"
import { callChat, salvageJson, modelSupportsVision } from "@/lib/deepseek"
import { normalizePage } from "@/lib/import-pipeline"
import { normalizeAnswerKey } from "@/lib/import-answer-key"

/**
 * 解析一页。**不抛异常**（除了上游错误会被包成返回值），调用方按 ok 分支处理。
 * @returns { page_no, ok, items?, notes?, readability?, stats?, truncated?, usage, raw?, error?, permanent? }
 */
export async function parseOnePage(page, opts) {
  const {
    apiKey,
    baseUrl,
    model,
    genAnalysis = true,
    defaultQtype = null,
    defaultDifficulty = 2,
    // 试卷模式：换用 PAPER_TAIL，并额外抽取卷头/大题/分值（见 lib/import-prompts.js）
    paperMode = false,
    // 答案区（0146）：答案键的条目。有它就把答案区交给模型比对，没有就与以前完全一样
    answerKey = null,
  } = opts
  const answerKeyEntries = Array.isArray(answerKey?.entries) ? answerKey.entries : null

  // 前置拦截：选了不支持图像的模型却要解析扫描页，与其让上游回一个 400，
  // 不如直接说清楚该换什么——这条提示比"解析服务返回 400"有用得多
  const images = page.images ?? []
  if (images.length > 0 && !modelSupportsVision(model)) {
    return {
      page_no: page.page_no,
      ok: false,
      permanent: true,
      usage: {},
      error: `当前模型（${model}）不支持图片，而第 ${page.page_no} 页是扫描件/图片。请在设置里换成 deepseek-flash，或只导入文字版文档`,
    }
  }

  const parts = buildPageParts({
    pageNo: page.page_no,
    text: page.text,
    // 上一页的末尾（二选一，见 lib/import-prompts.js）：文字片段或页面底部截图。
    // 由 buildPagePayload 就地生成——**不能只在同一批内传递**：一批只有几页，
    // 批与批之间、以及两条并发的车道之间都会断掉，跨页的题正好卡在断点上。
    prevTail: page.prev_tail,
    prevImages: (page.prev_images ?? []).map((img) => ({
      dataUrl: img.data_url,
      detail: page.detail,
    })),
    images: images.map((img) => ({ dataUrl: img.data_url, detail: page.detail })),
    note: page.note,
    paperMode,
    // Word 导入时素材单位是「批」，提示词里的"上一页/本页"要跟着换成"上一批/本批"
    unit: page.unit ?? "页",
    answerKeyEntries,
  })

  let content
  let finishReason
  let usage
  try {
    const r = await callChat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: parts },
      ],
      apiKey,
      baseUrl,
      model,
    })
    content = r.content
    finishReason = r.finishReason
    usage = r.usage
  } catch (err) {
    return {
      page_no: page.page_no,
      ok: false,
      error: err?.message ?? "解析失败",
      permanent: err?.transient === false,
      usage: {},
    }
  }

  const wire = salvageJson(content)
  if (!wire) {
    // 官方明确说了：开启 JSON Output 后"API 有概率返回空的 content"。
    // 这属于上游抽风而不是内容有问题，所以标成**可重试**——页级最多会自动重试 3 次；
    // 真要是三次都空，才会落到"失败"让教师手动重试。
    const empty = !content || content.trim() === ""
    return {
      page_no: page.page_no,
      ok: false,
      error: empty ? "模型返回了空内容（上游偶发，已自动重试）" : "模型返回的内容不是有效 JSON",
      permanent: !empty,
      usage,
      raw: content?.slice(0, 20000),
    }
  }

  const normalized = normalizePage(wire, {
    pageNo: page.page_no,
    defaultQtype: page.default_qtype ?? defaultQtype,
    defaultDifficulty: page.default_difficulty ?? defaultDifficulty,
    genAnalysis,
    paperMode,
    // 闸门：没有答案键时，"key"/answer_alt/新标记一律不产生（未执行 0146 的库也安全）
    hasAnswerKey: Boolean(answerKeyEntries?.length),
  })

  // 输出被截断（或抢救过）：把标记补到每道题上，教师在预览里能看见"末尾可能不全"
  const truncated = finishReason === "length" || Boolean(wire._salvaged)
  if (truncated) {
    for (const it of normalized.items) if (!it.flags.includes("truncated")) it.flags.push("truncated")
  }

  return {
    page_no: page.page_no,
    ok: true,
    items: normalized.items,
    notes: normalized.notes,
    readability: normalized.readability,
    stats: normalized.stats,
    // 这一页实际送了几张图：试跑面板会显示。0 张而界面说是扫描件，就说明素材没拿到
    // （句柄失效 / 渲染失败），而不是模型没认出题——这两种情况的排查方向完全不同。
    image_count: images.length,
    truncated,
    usage,
    raw: content?.slice(0, 20000),
    // 试卷模式下才有；调用方据此归集卷头与大题清单
    paper: normalized.paper ?? null,
    sections: normalized.sections ?? [],
  }
}

/**
 * 解析答案区的一页：只抽「题号 → 答案文本」，**不抽题目**（0146）。
 *
 * 与 parseOnePage 一样不抛异常：上游错误包成返回值，由调用方决定重试还是跳过。
 * 这里不做跨页上下文——答案条目本身是自足的，带上「上一页末尾」只会让模型
 * 把上一页的答案再抄一遍。
 */
export async function parseAnswerPage(page, opts) {
  const { apiKey, baseUrl, model } = opts
  const images = page.images ?? []

  if (images.length > 0 && !modelSupportsVision(model)) {
    return {
      page_no: page.page_no,
      ok: false,
      permanent: true,
      usage: {},
      error: `当前模型（${model}）不支持图片，而答案区第 ${page.page_no} 页是扫描件/图片。请在设置里换成 deepseek-flash，或换一份文字版答案`,
    }
  }

  const parts = buildAnswerParts({
    pageNo: page.page_no,
    text: page.text,
    images: images.map((img) => ({ dataUrl: img.data_url, detail: page.detail })),
    note: page.note,
    unit: page.unit ?? "页",
  })

  let content
  let finishReason
  let usage
  try {
    const r = await callChat({
      messages: [
        { role: "system", content: ANSWER_SYSTEM_PROMPT },
        { role: "user", content: parts },
      ],
      apiKey,
      baseUrl,
      model,
    })
    content = r.content
    finishReason = r.finishReason
    usage = r.usage
  } catch (err) {
    return {
      page_no: page.page_no,
      ok: false,
      error: err?.message ?? "答案区解析失败",
      permanent: err?.transient === false,
      usage: {},
    }
  }

  // 数组名是 answers：默认的 "questions" 在这里抢救不出任何东西
  const wire = salvageJson(content, "answers")
  if (!wire) {
    const empty = !content || content.trim() === ""
    return {
      page_no: page.page_no,
      ok: false,
      error: empty ? "模型返回了空内容（上游偶发，已自动重试）" : "模型返回的内容不是有效 JSON",
      permanent: !empty,
      usage,
      raw: content?.slice(0, 20000),
    }
  }

  const { entries, dropped, truncated } = normalizeAnswerKey(wire)
  return {
    page_no: page.page_no,
    ok: true,
    entries,
    dropped,
    truncated: truncated || finishReason === "length",
    readability: typeof wire?.readability === "string" ? wire.readability : null,
    notes: typeof wire?.notes === "string" ? wire.notes : null,
    usage,
    raw: content?.slice(0, 20000),
  }
}

/**
 * 把一页的解析结果落库（成功与失败都写——失败页也要让教师看见原因，
 * 而不是无声地停在"解析中"）。租约失效返回 { conflict: true }，调用方直接丢弃。
 */
export async function savePageResult(supabase, { jobId, leaseToken, mode, result }) {
  const payload = result.ok
    ? {
        p_status: "done",
        p_error: null,
        p_items: result.items.map((it) => ({
          qno: it.qno,
          qtype: it.qtype,
          difficulty: it.difficulty,
          content: it.content,
          flags: it.flags,
          confidence: it.confidence,
          source_quote: it.source_quote,
          // 试卷模式的三件套；普通导入是 null/undefined，落库后为空列
          section_title: it.section_title ?? null,
          score: it.score ?? null,
          score_mode: it.score_mode ?? null,
        })),
        p_usage: result.usage ?? {},
        p_raw: result.raw ?? null,
        // 整卷还原：卷头（一般只第 1 页有）与本页出现的大题。
        // 服务端只补空缺键，所以后续页传 {} 不会把先解析到的卷头抹掉（0050）
        p_paper: result.paper ?? {},
        p_sections: result.sections ?? [],
      }
    : {
        p_status: "failed",
        p_error: result.error ?? "解析失败",
        p_items: [],
        p_usage: result.usage ?? {},
        p_raw: result.raw ?? null,
        // 上游抽风（空内容 / 429 / 超时）值得自动重试；内容本身有问题就别浪费额度了。
        // 服务端在 attempts < 3 时把这类页放回 pending，跑批循环下一轮自动再试（见迁移 0037）
        p_retryable: !result.permanent,
      }

  // 这里原本有个 3 次重试的循环，专治连接池拥塞（PGRST003）。
  // 现在删掉了：重试统一收在传输层（lib/supabase/retry-fetch.js），那一处对所有请求都生效，
  // 而这里再来一层会**相乘** —— 3 次循环 × 每次 2 次 fetch，最坏要等 6 个池超时（约 6 分钟）。
  // 那种"重试反而更慢"的代码比不重试还难查。
  //
  // 页面卡在 running 直到租约过期（5 分钟）的顾虑仍然成立，但兜底还在：传输层会重试一次，
  // 真失败的话这页会在租约到期后被重新认领，不是永久卡死。

  // 「另一份答案」（0146）走包装函数：它内部先跑原样的 import_save_page，再补一次 UPDATE。
  // **seq 用数组下标**，不是 it.seq —— normalizePage 的 seq 赋值在去重之前，两者会错位，
  // 错位就会把别的题的答案挂到这道题上。
  const alts = result.ok
    ? result.items
        .map((it, i) => (it.answer_alt ? { seq: i, alt: it.answer_alt } : null))
        .filter(Boolean)
    : []
  const call = (rpc, extra) =>
    supabase.rpc(rpc, {
      p_job_id: jobId,
      p_page_no: result.page_no,
      p_lease_token: leaseToken,
      p_mode: mode ?? "auto",
      ...payload,
      ...extra,
    })

  let { data, error } = await call(
    alts.length ? "import_save_page_with_alts" : "import_save_page",
    alts.length ? { p_alts: alts } : {}
  )
  // 0146 未执行时包装函数不存在（PGRST202/42883）：退回原函数——这一页已经付过钱了，
  // 不能因为少写一列辅助信息就把整页结果丢掉。
  if (error && alts.length && (error.code === "PGRST202" || error.code === "42883")) {
    ;({ data, error } = await call("import_save_page", {}))
  }

  if (!error) {
    // 服务端顺带回传「这一页的新状态 + 任务计数」（迁移 0038）：客户端就地合并即可，
    // 跑批期间不必再查一次库——那类刷新曾占全部数据库请求的八成以上
    return { saved: true, page: data?.page ?? null, job: data?.job ?? null }
  }
  // 40001 = 租约失效：这页被别的标签页接手了，结果作废但不算失败（重试也没用）
  if (error.code === "40001" || /租约|标签页/.test(error.message ?? "")) {
    return { saved: false, conflict: true }
  }
  return { saved: false, error: error.message }
}
