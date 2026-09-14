// 「解析一页」的实现：拼消息 → 调上游 → 抢救 JSON → 规范化。
//
// 全部在浏览器里跑：教师填自己的 DeepSeek 密钥，请求从浏览器直达上游，
// 密钥与费用都不经过本站（官方 API 支持跨域，已实测）。调用方是
// lib/import-parse-client.js；回写数据库由它用 RPC 完成。
//
// 这里不读环境变量、不碰 Node API（没有纯函数测试之外的服务端用法）。

import { SYSTEM_PROMPT, buildPageParts } from "@/lib/import-prompts"
import { callChat, salvageJson, modelSupportsVision } from "@/lib/deepseek"
import { normalizePage } from "@/lib/import-pipeline"

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
  } = opts

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
    prevTail: page.prev_tail,
    images: images.map((img) => ({ dataUrl: img.data_url, detail: page.detail })),
    note: page.note,
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
    truncated,
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
        })),
        p_usage: result.usage ?? {},
        p_raw: result.raw ?? null,
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

  // 连接池拥塞（PGRST003「Timed out acquiring connection from connection pool」）
  // 之类的瞬时数据库问题要重试：不重试的话这页会一直是 running，直到租约过期（5 分钟）
  // 才被重新认领——白等五分钟，还可能被算成一次失败。
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(700 * attempt)

    const { data, error } = await supabase.rpc("import_save_page", {
      p_job_id: jobId,
      p_page_no: result.page_no,
      p_lease_token: leaseToken,
      p_mode: mode ?? "auto",
      ...payload,
    })

    if (!error) {
      // 服务端顺带回传「这一页的新状态 + 任务计数」（迁移 0038）：客户端就地合并即可，
      // 跑批期间不必再查一次库——那类刷新曾占全部数据库请求的八成以上
      return { saved: true, page: data?.page ?? null, job: data?.job ?? null }
    }
    // 40001 = 租约失效：这页被别的标签页接手了，结果作废但不算失败（重试也没用）
    if (error.code === "40001" || /租约|标签页/.test(error.message ?? "")) {
      return { saved: false, conflict: true }
    }
    const transient =
      error.code === "PGRST003" || /timed out|timeout|connection pool|deadlock/i.test(error.message ?? "")
    if (!transient || attempt === 2) return { saved: false, error: error.message }
  }
  return { saved: false, error: "落库失败" }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
