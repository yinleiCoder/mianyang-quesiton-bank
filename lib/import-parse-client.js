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

/** 试跑：只解析一页、不落库（同样需要密钥）。 */
export async function trialParse({ page, opts = {} }) {
  const apiKey = getDeepSeekKey()
  if (!apiKey) throw new MissingKeyError()
  const result = await parseOnePage(page, { ...opts, apiKey, model: getDeepSeekModel() })
  return { ok: true, dry_run: true, results: [result], usage: result.usage ? [result.usage] : [] }
}
