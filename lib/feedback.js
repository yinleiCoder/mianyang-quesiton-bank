// 意见反馈（服务端装载）：类型/平台/状态的中文口径 + 系统管理员收件箱数据。
// 可见性完全交给 RLS（0033 的 select_admin 策略只放行 is_admin()），装载器不做二次过滤；
// 提交人资料走 loadPeople 统一口径（含学生/待审核教师标签，见 lib/people.js）。
import { loadPeople } from "@/lib/people"

export const FEEDBACK_CATEGORIES = {
  bug: "问题反馈",
  feature: "功能建议",
  usage: "使用咨询",
  other: "其他",
}

export const FEEDBACK_PLATFORMS = {
  web: "网页端",
  android: "安卓端",
  windows: "Windows 端",
  ios: "iOS 端",
  other: "其他端",
}

export const FEEDBACK_STATES = {
  open: { text: "待处理", cls: "bg-amber-100 text-amber-700" },
  resolved: { text: "已处理", cls: "bg-emerald-100 text-emerald-700" },
}
export const feedbackStateChip = (s) =>
  FEEDBACK_STATES[s] ?? { text: s, cls: "bg-muted text-muted-foreground" }

export const feedbackCategoryLabel = (c) => FEEDBACK_CATEGORIES[c] ?? c
export const feedbackPlatformLabel = (p) => FEEDBACK_PLATFORMS[p] ?? p

// 收件箱筛选页签：key 直接进 ?status=，all 表示不加过滤
export const FEEDBACK_FILTERS = [
  { key: "open", label: "待处理" },
  { key: "resolved", label: "已处理" },
  { key: "all", label: "全部" },
]

const INBOX_COLUMNS =
  "id, user_id, category, content, contact, platform, client_version, " +
  "status, resolve_note, resolved_by, resolved_at, created_at"

export async function loadOpenFeedbackCount(supabase) {
  const res = await supabase
    .from("feedback")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
  if (res.error) throw res.error
  return res.count ?? 0
}

export async function loadFeedbackInbox(supabase, { status = "open", limit = 100 } = {}) {
  let q = supabase
    .from("feedback")
    .select(INBOX_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (status !== "all") q = q.eq("status", status)
  const res = await q
  if (res.error) throw res.error

  const rows = res.data ?? []
  if (rows.length === 0) return []
  const uids = [...new Set(rows.flatMap((r) => [r.user_id, r.resolved_by]).filter(Boolean))]
  const people = await loadPeople(supabase, uids)
  // 提交人可能已注销：user_id 随账号级联删除，这里只兜「资料查不到」的情况
  return rows.map((r) => ({
    ...r,
    submitter: people.get(r.user_id) ?? null,
    resolver: r.resolved_by ? (people.get(r.resolved_by) ?? null) : null,
  }))
}
