// 审批工作台数据装载（服务端 seed）：任务行 = approval + 被审对象（题目 / 试卷）+ 归属 + 人名。
//
// 数据源是统一视图 public.approval_inbox（题目 approvals ∪ 试卷 paper_approvals）。
// 为什么必须走视图而不是分别查两张表：侧栏角标、工作台待办、管理台审批记录等 9 处都在数
// "待我处理"，分开查的话每处都要写两遍，漏一处就是"数量少算了但没人报错"。
// 视图是 security_invoker 的，RLS 逐表按调用者身份生效——可见性判断仍然完全交给数据库。
//
// 行分两种靶子：target='question'（version_id 非空=内容任务；空=上下线事件）
// 与 target='paper'（paper_version_id 非空=内容任务）。装配时按 target 分派。
import { blocksToText, qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { indexNodes, subjectNodesQuery } from "@/lib/subject-nodes"
import { toISO } from "@/lib/format"

export const KIND_LABELS = {
  content: "内容入库",
  offline: "下线申请",
  restore: "恢复上线",
  paper: "试卷入库",
  paper_offline: "试卷下线",
  paper_restore: "试卷恢复上线",
}

export const STAGE_LABELS = {
  group: "教研组长",
  city: "市级专家",
}

// 「一键入库」的范围：**题目**的市级专家环节内容任务——通过即发布入库、全市可见。
// 组长环节通过只是把题转给专家（不等于入库）；上下线事件是题目级事件；
// 试卷任务虽然也是 city 环节，但它入库的是卷子不是题，不参与题目的批量入库。
const isPublishable = (a) => a.target === "question" && a.kind === "content" && a.stage === "city"

// 「一键流转」的范围：**题目**的教研组长环节内容任务——通过即流转市级专家（此时尚未入库）。
// 上下线事件（kind=offline/restore）刻意不在此列：它们没有下一环节，通过即生效，
// 混进"一键流转"就成了"一键下线"——语义完全不同，必须逐题处理。
const isFlowable = (a) => a.target === "question" && a.kind === "content" && a.stage === "group"

// 收件箱行 → 可批量入库 / 可批量流转的任务 id（行是 assemble() 出来的 { approval, … }）
export const publishableIdsOf = (rows) =>
  rows.filter((r) => isPublishable(r.approval)).map((r) => r.approval.id)

export const flowableIdsOf = (rows) =>
  rows.filter((r) => isFlowable(r.approval)).map((r) => r.approval.id)

// 「我的题目」页的轻量版：只查 id/kind/stage，不做 assemble（那要再打 5 次往返）。
// RLS 保证只看得到分给自己的行。
export async function loadMyPublishableIds(supabase, uid) {
  const { data, error } = await supabase
    .from("approval_inbox")
    .select("id, kind, stage, target")
    .contains("assigned_user_ids", [uid])
    .eq("state", "waiting")
  if (error) throw error
  return (data ?? []).filter(isPublishable).map((a) => a.id)
}

const INBOX_COLUMNS =
  "id, kind, stage, state, created_at, version_id, question_id, paper_version_id, paper_id, target, assigned_user_ids, school_id"

export async function loadInbox(supabase, uid, scope = null, schoolId = null) {
  // 处理人是一组人（岗位池）：`contains` 走 assigned_user_ids @> ARRAY[uid]，命中即我的待办。
  // 池内谁先处理算谁的——任务一离开 waiting，其余人的列表里自然就没有了
  const mineRes = await supabase
    .from("approval_inbox")
    .select(INBOX_COLUMNS)
    .contains("assigned_user_ids", [uid])
    .eq("state", "waiting")
    .order("created_at", { ascending: true })
  if (mineRes.error) throw mineRes.error

  const decidedRes = await supabase
    .from("approval_inbox")
    .select(`${INBOX_COLUMNS}, decided_at, comment`)
    .eq("decided_by", uid)
    .in("state", ["approved", "returned", "cancelled"])
    .order("decided_at", { ascending: false })
    .limit(30)
  if (decidedRes.error) throw decidedRes.error

  // 管理视图：scope='school'=本校在途任务（学校管理员）；scope='admin'=全量含待指派（系统管理员）
  let manageRes = { data: [], error: null }
  if (scope) {
    const q = supabase.from("approval_inbox").select(INBOX_COLUMNS).eq("state", "waiting")
    if (scope === "school") q.eq("school_id", schoolId)
    q.order("created_at", { ascending: true })
    manageRes = await q
  }
  if (manageRes.error) throw manageRes.error

  const [mineRows, decidedRows, manageRows] = await Promise.all([
    assemble(supabase, mineRes.data ?? []),
    assemble(supabase, decidedRes.data ?? []),
    assemble(supabase, manageRes.data ?? []),
  ])
  return { mineRows, decidedRows, manageRows }
}

// 处理人池 → 人名数组（已注销的账号查不到档案，跳过；空数组 = 待指派）
const namesOf = (userMap, ids) => (ids ?? []).map((id) => userMap.get(id) ?? "").filter(Boolean)

// 为同一批任务行补全展示字段。两种靶子分别装配后再按原顺序合并——
// 分别装配是因为它们要查的表完全不同，混在一起写会出现一堆 `a.target === 'paper' ? … : …`。
async function assemble(supabase, approvals) {
  if (approvals.length === 0) return []
  const qRows = approvals.filter((a) => a.target !== "paper")
  const pRows = approvals.filter((a) => a.target === "paper")
  const [qDone, pDone] = await Promise.all([
    assembleQuestions(supabase, qRows),
    assemblePapers(supabase, pRows),
  ])
  const byId = new Map([...qDone, ...pDone].map((r) => [r.approval.id, r]))
  return approvals.map((a) => byId.get(a.id)).filter(Boolean)
}

async function assembleQuestions(supabase, approvals) {
  if (approvals.length === 0) return []
  const qIds = [...new Set(approvals.map((a) => a.question_id).filter(Boolean))]
  const vIds = [...new Set(approvals.map((a) => a.version_id).filter(Boolean))]
  const uIds = [...new Set(approvals.flatMap((a) => [...(a.assigned_user_ids ?? []), a.decided_by]).filter(Boolean))]

  const [vRes, qRes, nRes, sRes, pRes] = await Promise.all([
    vIds.length
      ? supabase
          .from("question_versions")
          .select("id, question_id, version_no, status, qtype, difficulty, content, created_at, submitted_at, published_at")
          .in("id", vIds)
      : { data: [] },
    qIds.length
      ? supabase
          .from("questions")
          .select("id, school_id, course_node_id, state, creator_id, current_published_version_id")
          .in("id", qIds)
      : { data: [] },
    subjectNodesQuery(supabase),
    supabase.from("schools").select("id, name"),
    uIds.length ? supabase.from("profiles").select("user_id, name").in("user_id", uIds) : { data: [] },
  ])
  if (vRes.error) throw vRes.error
  if (qRes.error) throw qRes.error

  const nodePath = indexNodes(nRes.data).pathOf
  const schoolMap = new Map((sRes.data ?? []).map((s) => [s.id, s.name]))
  const userMap = new Map((pRes.data ?? []).map((p) => [p.user_id, p.name]))
  const versionMap = new Map((vRes.data ?? []).map((v) => [v.id, v]))
  const questionMap = new Map((qRes.data ?? []).map((q) => [q.id, q]))

  return approvals.map((a) => {
    const v = a.version_id ? versionMap.get(a.version_id) : null
    const q = questionMap.get(a.question_id)
    const content = v?.content
    return {
      approval: { ...a, created_at: toISO(a.created_at), decided_at: toISO(a.decided_at) },
      target: "question",
      kindLabel: KIND_LABELS[a.kind] ?? a.kind,
      stageLabel: STAGE_LABELS[a.stage] ?? a.stage,
      questionId: a.question_id,
      qtype: v?.qtype ?? null,
      qtypeLabel: v?.qtype ? qtypeLabel(v.qtype) : "",
      difficultyLabel: v?.difficulty != null ? difficultyLabel(v.difficulty) : "",
      versionNo: v?.version_no ?? null,
      versionStatus: v?.status ?? null,
      // 内容任务摘要取题干；下线/恢复事件无内容版本 → 取题目当前入库版本题干
      summary: content ? blocksToText(content.stem) : q ? "(状态变更申请，见任务详情)" : "",
      questionState: q?.state ?? null,
      nodePath: nodePath(q?.course_node_id),
      schoolName: q ? schoolMap.get(q.school_id) ?? "" : "",
      creatorName: q ? userMap.get(q.creator_id) ?? "" : "",
      assignedUserIds: a.assigned_user_ids ?? [],
      assignedNames: namesOf(userMap, a.assigned_user_ids),
      decidedByName: a.decided_by ? userMap.get(a.decided_by) ?? "" : "",
    }
  })
}

async function assemblePapers(supabase, approvals) {
  if (approvals.length === 0) return []
  const pIds = [...new Set(approvals.map((a) => a.paper_id).filter(Boolean))]
  const vIds = [...new Set(approvals.map((a) => a.paper_version_id).filter(Boolean))]
  const uIds = [...new Set(approvals.flatMap((a) => [...(a.assigned_user_ids ?? []), a.decided_by]).filter(Boolean))]

  const [vRes, pRes, cRes, nRes, sRes, uRes] = await Promise.all([
    vIds.length
      ? supabase
          .from("paper_versions")
          .select("id, paper_id, version_no, status, title, exam_name, subject_label, duration_minutes, total_score, target_score, submitted_at, published_at")
          .in("id", vIds)
      : { data: [] },
    pIds.length
      ? supabase.from("papers").select("id, school_id, course_node_id, state, creator_id").in("id", pIds)
      : { data: [] },
    // 题目数不在 paper_versions 上冗余，单独数一次（审批列表一页至多几十行，够用）
    vIds.length
      ? supabase.from("paper_items").select("paper_version_id").in("paper_version_id", vIds)
      : { data: [] },
    subjectNodesQuery(supabase),
    supabase.from("schools").select("id, name"),
    uIds.length ? supabase.from("profiles").select("user_id, name").in("user_id", uIds) : { data: [] },
  ])
  for (const r of [vRes, pRes, cRes]) if (r.error) throw r.error

  const nodePath = indexNodes(nRes.data).pathOf
  const schoolMap = new Map((sRes.data ?? []).map((s) => [s.id, s.name]))
  const userMap = new Map((uRes.data ?? []).map((p) => [p.user_id, p.name]))
  const versionMap = new Map((vRes.data ?? []).map((v) => [v.id, v]))
  const paperMap = new Map((pRes.data ?? []).map((p) => [p.id, p]))
  const countMap = new Map()
  for (const row of cRes.data ?? []) {
    countMap.set(row.paper_version_id, (countMap.get(row.paper_version_id) ?? 0) + 1)
  }

  return approvals.map((a) => {
    const v = a.paper_version_id ? versionMap.get(a.paper_version_id) : null
    const p = paperMap.get(a.paper_id)
    return {
      approval: { ...a, created_at: toISO(a.created_at), decided_at: toISO(a.decided_at) },
      target: "paper",
      kindLabel: KIND_LABELS[a.kind] ?? a.kind,
      stageLabel: STAGE_LABELS[a.stage] ?? a.stage,
      paperId: a.paper_id,
      versionNo: v?.version_no ?? null,
      versionStatus: v?.status ?? null,
      summary: v ? `${v.title}（${countMap.get(v.id) ?? 0} 题，满分 ${v.total_score} 分，${v.duration_minutes} 分钟）` : "",
      paperTitle: v?.title ?? "",
      paperState: p?.state ?? null,
      nodePath: nodePath(p?.course_node_id),
      schoolName: p ? schoolMap.get(p.school_id) ?? "" : "",
      creatorName: p ? userMap.get(p.creator_id) ?? "" : "",
      assignedUserIds: a.assigned_user_ids ?? [],
      assignedNames: namesOf(userMap, a.assigned_user_ids),
      decidedByName: a.decided_by ? userMap.get(a.decided_by) ?? "" : "",
    }
  })
}
