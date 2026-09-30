// 题目反馈（服务端装载 + 中文口径）。
//
// 与 lib/feedback.js 的区别值得先说清楚，两者长得像但不是一回事：
//   · feedback 是**通用意见反馈**，收件人是系统管理员，与题目无关；
//   · 这里挂在**具体题目**上，收件人是**出题人本人**，学校管理员兜底。
// 所以别把两者合并 —— 路由目标不同的东西合成一张表，RLS 会立刻变得没人看得懂。
//
// 可见性完全交给 RLS 与 RPC 内部断言（见 0066），装载器不做二次过滤。
// 提交人资料走 loadPeople 统一口径（它能兜住"账号已注销"）。

import { loadPeople } from "@/lib/people"

export const REPORT_CATEGORIES = {
  stem: "题干有误",
  answer: "答案有误",
  explanation: "解析有误",
  other: "其他问题",
}

export const REPORT_CATEGORY_KEYS = Object.keys(REPORT_CATEGORIES)

export const reportCategoryLabel = (c) => REPORT_CATEGORIES[c] ?? c

// 状态做成与 lib/feedback.js 同款的 {text, cls} 结构，页面上直接用。
//
// 0084 起是两种东西共用一张表：
//   · 学生纠错：open → resolved（作者标记已处理）
//   · 教师申诉：open → accepted（受理即下线，等作者整改）/ rejected / withdrawn
// 靠提交人的 profiles.identity 区分（服务端 is_teacher_appeal 同款口径），不加列。
export const REPORT_STATES = {
  open: { text: "待处理", cls: "bg-amber-100 text-amber-700" },
  resolved: { text: "已处理", cls: "bg-emerald-100 text-emerald-700" },
  rejected: { text: "已驳回", cls: "bg-muted text-muted-foreground" },
  withdrawn: { text: "已撤回", cls: "bg-muted text-muted-foreground" },
}

// 受理分两截看：题还下线着 = 整改中；题已经回到线上 = 这轮整改闭环了。
// 传 questionState 才能区分（收件箱与题目页手里都有它）。
export function reportStateChip(s, { questionState } = {}) {
  if (s === "accepted") {
    return questionState === "live"
      ? { text: "已受理 · 已整改上线", cls: "bg-emerald-100 text-emerald-700" }
      : { text: "已受理 · 整改中", cls: "bg-sky-100 text-sky-700" }
  }
  return REPORT_STATES[s] ?? { text: s, cls: "bg-muted text-muted-foreground" }
}

/** 教师提交的反馈 = 申诉（其余是学生纠错）。reporter 由 loadPeople 带出 identity。 */
export const isAppealReport = (r) => r?.reporter?.identity === "teacher"

export const REPORT_FILTERS = [
  { key: "open", label: "待处理" },
  { key: "resolved", label: "已处理" },
  { key: "all", label: "全部" },
]

/** 某道题的全部反馈（题目详情页的「本题反馈」区）。权限不够时 RPC 会抛错。 */
export async function loadQuestionReports(supabase, questionId) {
  const { data, error } = await supabase.rpc("list_question_reports", {
    p_question_id: questionId,
  })
  if (error) throw error
  const rows = data ?? []
  if (rows.length === 0) return []
  return attachReporters(supabase, rows)
}

/** 作者的处理收件箱（跨题目）。 */
export async function loadReportInbox(supabase, { status = "open", limit = 50, offset = 0 } = {}) {
  const { data, error } = await supabase.rpc("question_report_inbox", {
    p_status: status,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) throw error
  const rows = data ?? []
  // total_count 是 count(*) over () 带出来的，每行都一样；取第一行即可
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0
  return { rows: rows.length ? await attachReporters(supabase, rows) : [], total }
}

/**
 * 当前用户在某道题上提过的反馈（**学生自查用**）。
 *
 * 这是本功能与通用意见反馈最大的不同：**有回复闭环** —— 作者处理时写的那句
 * resolve_note 学生能看到（lib/feedback.js 那边是"不在这里回复"）。
 * 所以题面下方要给提交人把这句话亮出来，否则"我反馈了但没人理"的观感是一样的。
 *
 * 走直接 select 而不是 RPC：RLS 的 qr_select 已经放行「自己的行」，
 * 而 list_question_reports 只给处理人（会抛错）。两者是不同的问题，别混用。
 */
export async function loadMyQuestionReport(supabase, questionId, userId) {
  const { data, error } = await supabase
    .from("question_reports")
    .select("id, status, category, content, resolve_note, resolved_at, created_at")
    .eq("question_id", questionId)
    // 必须显式按 reporter_id 过滤：RLS 对作者/审题人也放行**别人的**行，
    // 不带这个条件的话，作者打开自己的题会看到"我的反馈"里写着学生的反馈。
    .eq("reporter_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/** 侧栏徽标：待我处理的条数。 */
export async function loadOpenReportCount(supabase) {
  const { data, error } = await supabase.rpc("count_open_question_reports")
  if (error) throw error
  return Number(data ?? 0)
}

/**
 * 某条反馈的往来消息（0084）。三方可见：提交人 / 本题作者 / 本题审题人。
 * 权限不够时 RPC 抛错 —— 装载器不做二次过滤（与上面几个同口径）。
 */
export async function loadReportMessages(supabase, reportId) {
  const { data, error } = await supabase.rpc("list_question_report_messages", {
    p_report_id: reportId,
  })
  if (error) throw error
  const rows = data ?? []
  if (rows.length === 0) return []
  const uids = [...new Set(rows.map((m) => m.author_id).filter(Boolean))]
  const people = uids.length ? await loadPeople(supabase, uids) : new Map()
  return rows.map((m) => ({
    ...m,
    author: m.author_id ? people.get(m.author_id) ?? null : null,
  }))
}

/**
 * 补上提交人资料。
 * reporter_id 可能为 null（学生注销后外键置空，见 0066）—— loadPeople 会跳过空值，
 * 页面据此显示「账号已注销」，而不是把一个 UUID 露出去。
 */
async function attachReporters(supabase, rows) {
  const uids = [...new Set(rows.flatMap((r) => [r.reporter_id, r.resolved_by]).filter(Boolean))]
  const people = uids.length ? await loadPeople(supabase, uids) : new Map()
  return rows.map((r) => ({
    ...r,
    reporter: r.reporter_id ? people.get(r.reporter_id) ?? null : null,
    resolver: r.resolved_by ? people.get(r.resolved_by) ?? null : null,
  }))
}
