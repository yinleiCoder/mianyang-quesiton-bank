// 工作台的数据层：与 page.jsx 的展示层分开，页面文件只留 UI 结构与 <Suspense> 边界。
//
// 每个 loader 自己建 client：react cache() 按参数去重，传 supabase 对象每次都是新引用、去重会失效。
// 一个区块一份 loader，区块之间互不阻塞 —— 这正是把它们拆进各自 <Suspense> 的意义。
// 「我的题目」与「我的进行中」共用 getMyRows()，同一请求内只打一次。
//
// 本文件只在服务端被 page.jsx 引用（含 next/headers 的调用链），不要被客户端组件 import。
import { cache } from "react"
import { getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadMyQuestions, WORKBENCH_FILTERS } from "@/lib/question-workbench"

// 各状态计数：直接复用 /questions 筛选页签的谓词，两处口径永远一致
//（displayState 的取值是 pending_group/pending_city/published，不能按原样当键）
export function countByFilter(rows) {
  return Object.fromEntries(
    WORKBENCH_FILTERS.map((f) => [f.key, rows.filter((r) => f.match(r.displayState)).length])
  )
}

export const getMyRows = cache(async () => {
  const ctx = await getAuthContext()
  const uid = ctx.user?.id ?? ""
  if (!uid) return []
  const { rows } = await loadMyQuestions(await createClient(), uid)
  return rows ?? []
})

export const getBankCount = cache(async () => {
  const supabase = await createClient()
  const { count, error } = await supabase
    .from("question_versions")
    .select("id, question:questions!question_versions_question_id_fkey!inner(id)", { count: "exact", head: true })
    .eq("status", "published")
    .eq("question.state", "live")
  // 统计卡必须查得到，否则数字会静默显示成 0（错误由 (app)/error.jsx 兜底）
  if (error) throw error
  return count ?? 0
})

export const getMyWaiting = cache(async () => {
  const ctx = await getAuthContext()
  const { count, error } = await (await createClient())
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("state", "waiting")
    .eq("assigned_user_id", ctx.user?.id ?? "")
  if (error) throw error
  return count ?? 0
})

export const getAdminStats = cache(async () => {
  const supabase = await createClient()
  const [schoolsC, usersC, nodesC, tagsC, unassignedC] = await Promise.all([
    supabase.from("schools").select("id", { count: "exact", head: true }),
    supabase.from("profiles").select("user_id", { count: "exact", head: true }),
    supabase.from("subject_nodes").select("id", { count: "exact", head: true }),
    supabase.from("tags").select("id", { count: "exact", head: true }),
    supabase.from("approvals").select("id", { count: "exact", head: true }).eq("state", "waiting").is("assigned_user_id", null),
  ])
  return {
    schools: schoolsC.count ?? 0,
    users: usersC.count ?? 0,
    nodes: nodesC.count ?? 0,
    tags: tagsC.count ?? 0,
    unassigned: unassignedC.count ?? 0,
  }
})

export const getRecent = cache(async () => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("question_versions")
    .select(
      "id, question_id, version_no, qtype, content, published_at, created_by, question:questions!question_versions_question_id_fkey!inner(id, school_id, creator_id, state)"
    )
    .eq("status", "published")
    .eq("question.state", "live")
    .order("published_at", { ascending: false })
    .limit(5)
  if (error) throw error
  const recent = data ?? []
  // 行外字典：学校名 + 作者姓名（school_id 在 questions 上，作者取 created_by）
  const schoolIds = [...new Set(recent.map((v) => v.question?.school_id).filter(Boolean))]
  const creatorIds = [...new Set(recent.map((v) => v.created_by).filter(Boolean))]
  const [schoolRes, profileRes] = await Promise.all([
    schoolIds.length ? supabase.from("schools").select("id, name").in("id", schoolIds) : Promise.resolve({ data: [] }),
    creatorIds.length
      ? supabase.from("profiles").select("user_id, name").in("user_id", creatorIds)
      : Promise.resolve({ data: [] }),
  ])
  return {
    recent,
    schoolMap: new Map((schoolRes.data ?? []).map((s) => [s.id, s.name])),
    creatorMap: new Map((profileRes.data ?? []).map((p) => [p.user_id, p.name])),
  }
})

export const getSchoolStats = cache(async () => {
  const { data, error } = await (await createClient()).rpc("school_contribution_stats")
  // 学校贡献图表为可选区块：查询失败时隐藏卡片即可（学校贡献 RPC 未部署/无权限）
  return error ? null : (data ?? [])
})
