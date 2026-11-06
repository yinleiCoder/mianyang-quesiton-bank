"use client"

// 浏览器侧的解析编排：**用使用者自己的 DeepSeek 密钥，从浏览器直连上游**。
//
// 为什么是这条路：
//   · 官方 API 支持浏览器跨域（已实测预检返回 access-control-allow-origin），所以请求
//     不必经过我们的服务器——密钥不出使用者的浏览器，站点也不承担任何解析费用；
//   · 因此**没有密钥就不能用**：这里在入口处硬拦，界面上的引导见 DeepSeekSettingsPanel。
//
// 落库仍走数据库的 RPC（import_save_page），所以权限、租约、幂等这些约束一个都没少。

import { createClient } from "@/lib/supabase/client"
import { getDeepSeekKey, getDeepSeekModel } from "@/lib/deepseek-prefs"
import { parseOnePage, parseAnswerPage, savePageResult } from "@/lib/import-parse"
import { mergeAnswerEntries } from "@/lib/import-answer-key"

// 落库失败补试一次（间隔 3 秒）。
//
// 为什么值得为它单独加一层重试：模型那一步已经付过费了，结果只存在于这个函数的局部变量里，
// 丢掉就得**重新调一次模型、再花一次钱**。补试一次只要几秒。
//
// 为什么只有一次、而不是三次五次：PostgREST 池满（PGRST003/504）的等待窗口实测约 125 秒，
// 每次尝试都可能让这个页面卡上几分钟；传输层已经会为这一种错误自动重试一次
// （见 lib/supabase/retry-fetch.js 的说明），这里再加一层紧密循环会与它相乘。
// 所以取"再等一次"而不是"多试几次"——真存不进去就把结论交给界面讲清楚（见下面的 saves）。
const SAVE_RETRIES = 1
const SAVE_RETRY_DELAY_MS = 3000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class MissingKeyError extends Error {
  constructor() {
    super("还没有配置 DeepSeek 密钥：AI 解析需要你自己的密钥（费用由你承担，密钥只存在本机浏览器）")
    this.name = "MissingKeyError"
  }
}

export function hasOwnKey() {
  return Boolean(getDeepSeekKey())
}

/**
 * 解析并落库一批页。没有密钥直接抛 MissingKeyError（界面会引导去配置）。
 *
 * **租约逐页取**：每页的 `lease_token` 由调用方在认领后贴在该页的素材上（见
 * components/import/import-run.jsx）。不是"一批一个"——import_claim_pages 是逐行
 * gen_random_uuid()，同一批三页的 token 互不相同，拿批内第一页的 token 去存其余页，
 * 服务端按租约守卫判成「该页已被其他标签页处理」并丢弃结果（40001）。
 *
 * @param onPageSaved 每页落库后回调一次——进度要"每页就动"，不能等整批跑完（会看起来卡住）
 */
export async function parseAndSavePages({ jobId, pages, opts = {}, onPageSaved }) {
  const apiKey = getDeepSeekKey()
  if (!apiKey) throw new MissingKeyError()
  const model = getDeepSeekModel()

  // 缺租约是编码错误（认领结果没贴上）。**当场炸**比让服务端判成"已被其他标签页处理"
  // 好排查得多——后者会让人去找一个根本不存在的标签页，还会把模型的钱白花掉。
  const noLease = pages.find((p) => !p.lease_token)
  if (noLease) throw new Error(`第 ${noLease.page_no} 页没有租约 token（认领结果没带上）`)

  const supabase = createClient()
  // 批内并发：各页互不依赖，串行会把延迟乘上页数
  const settled = await Promise.allSettled(pages.map((p) => parseOnePage(p, { ...opts, apiKey, model })))

  const results = []
  const usage = []
  const saves = []
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const s = settled[i]
    const r =
      s.status === "fulfilled"
        ? s.value
        : {
            page_no: page.page_no,
            ok: false,
            error: String(s.reason?.message ?? s.reason ?? "解析失败"),
            permanent: s.reason?.transient === false,
            usage: {},
          }
    if (r.usage) usage.push(r.usage)
    results.push(r)
    const save = () =>
      savePageResult(supabase, {
        jobId,
        // 这一页自己的租约（见函数说明）
        leaseToken: page.lease_token,
        mode: page.mode,
        result: r,
      })
    let saveRes = await save()
    // 租约冲突不补试（那页已经不是我们的了，再存也白搭，而且重试会污染"谁接手了"的判断）；
    // 其余失败（池满/网络抖动）补一次——结果还在手里，扔了就得重新花钱
    for (let n = 0; n < SAVE_RETRIES && !saveRes.saved && !saveRes.conflict; n++) {
      await sleep(SAVE_RETRY_DELAY_MS)
      saveRes = await save()
    }
    saves.push({ page_no: r.page_no, ...saveRes })
    // 每页落库后立刻把新进度交给界面**就地合并**（saveRes 里带着服务端回传的页状态与任务计数），
    // 不必再查库。回调是 fire-and-forget 的，这里兜住异常——否则一次失败会变成
    // 未处理的 rejection 并以 [object Object] 的形式糊在页面上（PostgrestError 不是 Error）
    try {
      onPageSaved?.(saveRes)
    } catch {
      // 只在界面上更新失败，不影响解析结果
    }
  }
  return { ok: true, results, saves, usage }
}

/**
 * 解析答案区（0146）：逐页跑，**每跑完一页就把累积后的完整答案键写回库**。
 *
 * 为什么整体替换而不是增量合并：替换是幂等的，中途失败最多重跑一页；增量合并一旦
 * 中途失败，库里会留两份半截数据，看不出来哪份新。
 *
 * `key.pages` 记着每页的成败，所以刷新/换设备之后只重跑没成功的那几页——
 * 那几页的钱不该再花第二遍。
 *
 * buildPayload 由调用方传（它是 components/import/import-wizard.jsx 里的函数，
 * 而那个文件有 React 组件，lib 不能反向依赖它）。
 *
 * @param onPage 每页开始/结束回调一次，界面据此显示「解析答案区 3/10」
 * @returns { key, failures } key 是落库后的完整答案键
 */
export async function parseAnswerSource({
  jobId,
  source,
  from,
  to,
  key,
  buildPayload,
  onPage,
  shouldStop,
  opts = {},
}) {
  const apiKey = getDeepSeekKey()
  if (!apiKey) throw new MissingKeyError()
  const model = getDeepSeekModel()
  const supabase = createClient()

  let entries = [...(key?.entries ?? [])]
  const pages = [...(key?.pages ?? [])]
  const done = new Set(pages.filter((p) => p.ok).map((p) => p.page_no))
  let truncated = Boolean(key?.truncated)

  const persist = async (extra = {}) => {
    const next = {
      version: 1,
      source: { kind: source.kind, name: source.name, pages: source.pages },
      from,
      to,
      entries,
      pages,
      truncated,
      ...extra,
    }
    // jobId 为空 = 试跑：只算不存（向导里还没有任务可挂）
    if (!jobId) return next
    const { error } = await supabase.rpc("import_set_answer_key", { p_job_id: jobId, p_key: next })
    if (error) throw new Error(`答案区结果没能存进数据库：${error.message}`)
    return next
  }

  const failures = []
  let stopped = false
  for (let pageNo = from; pageNo <= to; pageNo++) {
    if (shouldStop?.()) {
      stopped = true
      break
    }
    if (done.has(pageNo)) continue
    onPage?.({ pageNo, status: "running", total: to - from + 1, done: pages.filter((p) => p.ok).length })

    let result = null
    // 单页最多试 3 次：前两次只对"瞬时"失败有意义（空内容 / 429 / 超时），
    // 内容本身有问题（格式不对）再试也是白花钱
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await buildPayload(source, pageNo)
      result = await parseAnswerPage(page, { ...opts, apiKey, model })
      if (result.ok || result.permanent) break
      await sleep(1000 * (attempt + 1))
    }

    const ok = Boolean(result?.ok)
    // 同一页重跑时替换旧记录，不要越攒越多（续跑时失败的页会被再跑一次）
    const pageEntry = {
      page_no: pageNo,
      ok,
      error: ok ? null : result?.error ?? "解析失败",
      at: new Date().toISOString(),
    }
    const seenAt = pages.findIndex((p) => p.page_no === pageNo)
    if (seenAt >= 0) pages[seenAt] = pageEntry
    else pages.push(pageEntry)
    if (ok) {
      // 重跑这一页时先把它上一轮的条目摘掉，否则 mergeAnswerEntries 会保留更旧的那份
      const fresh = result.entries.map((e) => ({ ...e, page: pageNo }))
      entries = mergeAnswerEntries(entries.filter((e) => e.page !== pageNo), fresh)
      truncated = truncated || Boolean(result.truncated)
    } else {
      failures.push({ page_no: pageNo, error: result?.error ?? "解析失败" })
    }
    onPage?.({ pageNo, status: ok ? "done" : "failed", total: to - from + 1, done: pages.filter((p) => p.ok).length })
    // 每页都落库：失败的页也记一笔，续跑时才知道哪些还没成
    await persist({ parsed_at: null })
  }

  // 只有「每页都真的跑成了」才打 parsed_at——它是"答案区已解析完"的唯一判据，
  // 中途停下（暂停/关页面）或还有失败页时留 null，续跑据此重新进入预解析。
  const complete = !stopped && failures.length === 0
  const finalKey = await persist({
    parsed_at: complete ? new Date().toISOString() : null,
    partial: !complete,
  })
  return { key: finalKey, failures, stopped }
}

/** 试跑：只解析一页、不落库（同样需要密钥）。 */
export async function trialParse({ page, opts = {} }) {
  const apiKey = getDeepSeekKey()
  if (!apiKey) throw new MissingKeyError()
  const result = await parseOnePage(page, { ...opts, apiKey, model: getDeepSeekModel() })
  return { ok: true, dry_run: true, results: [result], usage: result.usage ? [result.usage] : [] }
}
