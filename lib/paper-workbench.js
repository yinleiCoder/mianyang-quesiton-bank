// 试卷读侧的服务端 loader。与 lib/review-workbench.js 同一形态：
// 只负责"打一次往返把页面要的东西取齐"，装配与权限判断交给 RPC 与 RLS。
//
// 为什么读整卷要走 RPC 而不是 PostgREST：题项引用的是**定版指针**，题目改版/下线后
// 那一版在 RLS 下不可见，而"考过的卷子不会变"要求这些内容照常渲染。
// lib/paper-workbench.js 自身不 import next/cache 相关的参考数据——那由页面取好传进来。

export const PAPER_STATUS = {
  draft: { text: "草稿", cls: "bg-muted text-muted-foreground" },
  pending_group: { text: "组长审核中", cls: "bg-amber-100 text-amber-700" },
  pending_city: { text: "专家审核中", cls: "bg-orange-100 text-orange-700" },
  published: { text: "已入库", cls: "bg-emerald-100 text-emerald-700" },
  superseded: { text: "已被新版本替换", cls: "bg-muted text-muted-foreground" },
  returned: { text: "已退回", cls: "bg-rose-100 text-rose-700" },
  retracted: { text: "已撤回", cls: "bg-muted text-muted-foreground" },
}
export const paperStatusChip = (status) =>
  PAPER_STATUS[status] ?? { text: status, cls: "bg-muted text-muted-foreground" }

export async function loadPaperLibrary(supabase, { node = null, kw = null, limit = 20, offset = 0 } = {}) {
  const { data, error } = await supabase.rpc("list_papers", {
    p_node: node,
    p_kw: kw,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) throw error
  return data ?? { total: 0, limit, offset, papers: [] }
}

export async function loadMyPapers(supabase, { limit = 50, offset = 0 } = {}) {
  const { data, error } = await supabase.rpc("list_my_papers", { p_limit: limit, p_offset: offset })
  if (error) throw error
  return data ?? { total: 0, limit, offset, papers: [] }
}

// 整卷快照（编辑 / 详情 / 审批 / 打印共用同一个结构）
export async function loadPaperVersion(supabase, versionId) {
  const { data, error } = await supabase.rpc("get_paper_version", { p_version_id: versionId })
  if (error) throw error
  return data
}

// 有问题的题项（已下线/已改版）。返回 Map<item_id, problem> 供列表与编辑器打标签。
export async function loadPaperHealth(supabase, versionId) {
  const { data, error } = await supabase.rpc("paper_health", { p_version_id: versionId })
  if (error) throw error
  const map = new Map()
  for (const row of data ?? []) map.set(row.item_id, row.problem)
  return map
}

export const HEALTH_LABEL = {
  offline: "题目已下线",
  superseded: "题目版本已失效",
  stale: "题库有新版本",
  missing: "题目已不存在",
}

// 卷面统计：打印页与详情页都要显示"共 N 题、满分 M 分"
export function paperStats(snapshot) {
  const sections = snapshot?.sections ?? []
  return {
    sectionCount: sections.length,
    itemCount: sections.reduce((a, s) => a + (s.items?.length ?? 0), 0),
    totalScore: Number(snapshot?.total_score ?? 0),
  }
}

// 在做卷 / 已发布：组卷库详情与打印走这条；草稿只有作者与审批人看得到（RLS 兜底）
export function isPaperVisibleToAll(snapshot) {
  return snapshot?.status === "published" && snapshot?.paper_state === "live"
}

// 审批详情的候选转派人：group 环节 = 本校生效组长（无则本校成员）；city 环节 = 全市生效专家。
// 与题目审批的口径一致（见 app/(app)/review/[id]/page.jsx），只是学校取试卷的归属学校。
export async function loadPaperTransferCandidates(supabase, stage, schoolId, schoolMap) {
  const base = () => supabase.from("approver_assignments").select("user_id").eq("is_active", true)
  let ids = []
  if (stage === "group") {
    const { data: leaders } = await base().eq("school_id", schoolId).eq("role", "group_leader")
    ids = (leaders ?? []).map((l) => l.user_id)
    if (ids.length === 0) {
      const { data: members } = await supabase.from("profiles").select("user_id").eq("school_id", schoolId)
      ids = (members ?? []).map((m) => m.user_id)
    }
  } else {
    const { data: experts } = await base().eq("role", "city_expert")
    ids = (experts ?? []).map((e) => e.user_id)
  }
  ids = [...new Set(ids)]
  if (ids.length === 0) return []
  const { data } = await supabase.from("profiles").select("user_id, name, school_id").in("user_id", ids)
  return (data ?? []).map((p) => ({
    user_id: p.user_id,
    name: p.name ?? "",
    schoolName: schoolMap?.get(p.school_id) ?? "",
  }))
}
