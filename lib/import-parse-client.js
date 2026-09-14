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
import { parseOnePage, savePageResult } from "@/lib/import-parse"

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
 * @param onPageSaved 每页落库后回调一次——进度要"每页就动"，不能等整批跑完（会看起来卡住）
 */
export async function parseAndSavePages({ jobId, leaseToken, pages, opts = {}, onPageSaved }) {
  const apiKey = getDeepSeekKey()
  if (!apiKey) throw new MissingKeyError()
  const model = getDeepSeekModel()

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
    const saveRes = await savePageResult(supabase, {
      jobId,
      leaseToken,
      mode: page.mode,
      result: r,
    })
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

/** 试跑：只解析一页、不落库（同样需要密钥）。 */
export async function trialParse({ page, opts = {} }) {
  const apiKey = getDeepSeekKey()
  if (!apiKey) throw new MissingKeyError()
  const result = await parseOnePage(page, { ...opts, apiKey, model: getDeepSeekModel() })
  return { ok: true, dry_run: true, results: [result], usage: result.usage ? [result.usage] : [] }
}
