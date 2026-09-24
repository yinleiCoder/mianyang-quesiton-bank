// 试卷成绩榜的取数与纯口径（服务端页面用，客户端重查也可复用）。
//
// 与 lib/students.js 同一套写法：失败返回 null（不是空数组）—— null = "这次没查成"、
// [] = "查成了，就是空的"。两者混为一谈会让一次网络抖动把整张榜清空。
//
// **权限不在这一层**：paper_leaderboard 是 SECURITY DEFINER，范围解析（学生只能看自己班 /
// 自己学校；教师看班级必须过 can_view_class）全在 SQL 的 resolve_paper_scope 里（0077）。
// 前端拿不到越权数据不是因为这里筛过，而是因为 SQL 里筛过 —— UI 不是安全边界。
//
// ⚠ 会被 "use client" 组件引用，**绝不能 import next/cache**（同 lib/students.js 的约定）。

import { HIGH_ERROR_RATE } from "@/lib/accuracy"

// ---------- 范围（全班 / 全校 / 全市） ----------

export const SCOPE_KEYS = ["class", "school", "city"]

export const SCOPE_LABELS = { class: "全班", school: "全校", city: "全市" }

// 页面上的两个页签：成绩排行 / 试题分析（同一份卷子的两种看法）
export const TAB_KEYS = ["rank", "questions"]

export const TAB_LABELS = { rank: "成绩排行", questions: "试题分析" }

// 筛选口径：服务端页面解析、页签链接改写共用一份键表（同 lib/students.js 的做法）
export function parseAnalyticsFilters(searchParams = {}) {
  const str = (v) => (typeof v === "string" ? v : "")
  const scope = str(searchParams.scope)
  const tab = str(searchParams.tab)
  return {
    tab: TAB_KEYS.includes(tab) ? tab : "rank",
    scope: SCOPE_KEYS.includes(scope) ? scope : "class",
    classId: str(searchParams.class),
  }
}

export function analyticsQueryString({ tab, scope, classId } = {}) {
  const sp = new URLSearchParams()
  if (tab && tab !== "rank") sp.set("tab", tab)
  if (scope && scope !== "class") sp.set("scope", scope)
  if (classId) sp.set("class", classId)
  return sp.toString()
}

// ---------- 取数 ----------

/**
 * 一份卷子的成绩榜。
 * @returns { board, needClass, denied, error } —— 三者互斥地解释"为什么没有数据"：
 *   needClass：教师看班级榜但没选班（SQLSTATE 22023），页面据此出班级选择器；
 *   denied：无权看这个班（42501）；
 *   error：其它失败。
 */
export async function loadPaperLeaderboard(supabase, { paperId, scope = "class", classId = null }) {
  const { data, error } = await supabase.rpc("paper_leaderboard", {
    p_paper_id: paperId,
    p_scope: scope,
    p_class_id: classId || null,
  })
  if (error) {
    return {
      board: null,
      needClass: error.code === "22023",
      denied: error.code === "42501",
      error,
    }
  }
  return { board: data, needClass: false, denied: false, error: null }
}

/**
 * 一份卷子的逐题分析（每题正确率、选项分布、错答名单）。
 *
 * 与榜单同一个范围口径，但**门禁更严一档**：学生必须自己已经出分（否则选项分布 +
 * 标准答案合起来就是答案本身）。没出分时 RPC 抛 42501，页面据此显示"出分后可见"。
 */
export async function loadPaperQuestionStats(supabase, { paperId, scope = "class", classId = null }) {
  const { data, error } = await supabase.rpc("paper_question_stats", {
    p_paper_id: paperId,
    p_scope: scope,
    p_class_id: classId || null,
  })
  if (error) {
    return {
      stats: null,
      needClass: error.code === "22023",
      denied: error.code === "42501",
      error,
    }
  }
  return { stats: data, needClass: false, denied: false, error: null }
}

/**
 * 班级学情看板（0079）。权限：can_view_class（系统管理员 / 本校管理员 / 本校本专业教师），
 * 越权时 RPC 抛 42501，页面据此显示"不能查看这个班级"。
 */
export async function loadClassReport(supabase, { classId, days = 30 }) {
  const { data, error } = await supabase.rpc("class_learning_report", {
    p_class_id: classId,
    p_days: days,
  })
  if (error) return { report: null, denied: error.code === "42501", error }
  return { report: data, denied: false, error: null }
}

// ---------- 纯口径 ----------

// 「高危题」的门槛：正确率低于它就要拎出来讲。
// 直接由 lib/accuracy.js 的 HIGH_ERROR_RATE（错误率 ≥ 60%）推出来——
// 全站只有这一条线，别在这里另写一个 0.5（两边不一致时，题库页标红、讲评页不标红，
// 教师会以为是数据错了）。
export const LOW_CORRECT_RATE = 1 - HIGH_ERROR_RATE

// 「我为什么不在榜上」。文案要给出下一步动作——只写"你不在榜上"等于什么都没说。
export function viewerNoteText(note) {
  switch (note) {
    case "not_submitted":
      return "你还没交过这份卷子：交卷后就会出现在榜上。"
    case "not_official":
      return "你这一场是自主练习。同一份卷只有第一次交卷计入排行，练习场次不计分。"
    case "not_graded":
      return "你已交卷，等主观题判完出分后才会进榜。"
    case "not_in_class":
      return "你还没有分班，看不到全班榜——先看全校或全市。"
    case "empty_scope":
      return "这个范围里还没有可比的成绩。"
    default:
      return null
  }
}

// 名次徽章：前三名给金银铜，其余是普通数字。多邻国那套"领奖台"的最小实现，纯 CSS。
export function rankTone(rank) {
  if (rank === 1) return "bg-amber-100 text-amber-800 ring-amber-300"
  if (rank === 2) return "bg-slate-100 text-slate-700 ring-slate-300"
  if (rank === 3) return "bg-orange-100 text-orange-800 ring-orange-300"
  return "bg-muted text-muted-foreground ring-border"
}

// 单场考试的用时：mm:ss（超过一小时给 h:mm:ss）。
// 与 student-detail.jsx 的 humanDuration 不同口径：那边是**累计**用时（"3 小时 12 分"），
// 这边是**一场**考试（"23:45"），排行榜上一行一个，越紧凑越好。
export function fmtDuration(ms) {
  const n = Number(ms) || 0
  if (n <= 0) return ""
  const total = Math.round(n / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (x) => String(x).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

// 得分率 → 百分数文案；没有满分（理论上不会）时返回 "—" 而不是 NaN%
export function percentText(percent) {
  const p = Number(percent)
  if (!Number.isFinite(p)) return "—"
  return `${Math.round(p * 100)}%`
}

// 正确率条形的三档配色（<50% 红 / <75% 黄 / 其余绿）。
//
// **与 HIGH_ERROR_RATE（0.6）不是一回事**，别合并：
//   · HIGH_ERROR_RATE 判的是"**一道题**是不是高危题、要不要拎出来讲"；
//   · 这里判的是"**一个知识点 / 一个学生**是不是该关注"——它天然要比单题宽松
//     （单个知识点往往跨很多题，混着易题和难题）。
// 个人学情页原先自己写了一份一模一样的，上提到这里与班级看板共用。
export function accuracyBarColor(accuracy) {
  if (accuracy < 0.5) return "bg-rose-500/80"
  if (accuracy < 0.75) return "bg-amber-500/80"
  return "bg-emerald-500/80"
}
