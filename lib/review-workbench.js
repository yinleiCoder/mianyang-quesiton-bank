// 审批工作台数据装载（服务端 seed）：任务行 = approval + 题目/版本/学校/节点/人名 合并。
// 可见性完全交给 RLS（assigned_user_id=我 / decided_by=我 / 管理员 / 本校管理员 / 作者）。
// content 任务挂在版本上（version_id 非空）；offline/restore 事件任务挂在题目上（version_id 空）。
import { blocksToText, qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { indexNodes, subjectNodesQuery } from "@/lib/subject-nodes"
import { toISO } from "@/lib/format"

export const KIND_LABELS = {
  content: "内容入库",
  offline: "下线申请",
  restore: "恢复上线",
}

export const STAGE_LABELS = {
  group: "教研组长",
  city: "市级专家",
}

export async function loadInbox(supabase, uid, scope = null, schoolId = null) {
  const mineRes = await supabase
    .from("approvals")
    .select("id, kind, stage, state, created_at, version_id, question_id, assigned_user_id")
    .eq("assigned_user_id", uid)
    .eq("state", "waiting")
    .order("created_at", { ascending: true })
  if (mineRes.error) throw mineRes.error

  const decidedRes = await supabase
    .from("approvals")
    .select("id, kind, stage, state, created_at, decided_at, comment, version_id, question_id, assigned_user_id")
    .eq("decided_by", uid)
    .in("state", ["approved", "returned", "cancelled"])
    .order("decided_at", { ascending: false })
    .limit(30)
  if (decidedRes.error) throw decidedRes.error

  // 管理视图：scope='school'=本校题目在途任务（学校管理员）；scope='admin'=全量含待指派（系统管理员）
  let manageRes = { data: [], error: null }
  if (scope) {
    const q = supabase
      .from("approvals")
      .select(
        "id, kind, stage, state, created_at, version_id, question_id, assigned_user_id, question:questions!inner(school_id)"
      )
      .eq("state", "waiting")
    if (scope === "school") q.eq("question.school_id", schoolId)
    q.order("created_at", { ascending: true })
    manageRes = await q
  }
  if (manageRes.error) throw manageRes.error
  // question 关联只为按学校过滤，装配阶段不需要
  const manage = (manageRes.data ?? []).map(({ question, ...rest }) => rest)

  const mine = mineRes.data ?? []
  const decided = decidedRes.data ?? []

  const [mineRows, decidedRows, manageRows] = await Promise.all([
    assemble(supabase, mine),
    assemble(supabase, decided),
    assemble(supabase, manage),
  ])
  return { mineRows, decidedRows, manageRows }
}

// 为同一批任务行补全展示字段
async function assemble(supabase, approvals) {
  if (approvals.length === 0) return []
  const qIds = [...new Set(approvals.map((a) => a.question_id))]
  const vIds = [...new Set(approvals.map((a) => a.version_id).filter(Boolean))]
  const uIds = [
    ...new Set(
      approvals.flatMap((a) => [a.assigned_user_id, a.decided_by]).filter(Boolean)
    ),
  ]

  const [vRes, qRes, nRes, sRes, pRes] = await Promise.all([
    vIds.length
      ? supabase
          .from("question_versions")
          .select("id, question_id, version_no, status, qtype, difficulty, content, created_at, submitted_at, published_at")
          .in("id", vIds)
      : { data: [] },
    supabase
      .from("questions")
      .select("id, school_id, course_node_id, state, creator_id, current_published_version_id")
      .in("id", qIds),
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
      kindLabel: KIND_LABELS[a.kind] ?? a.kind,
      stageLabel: STAGE_LABELS[a.stage] ?? a.stage,
      questionId: a.question_id,
      qtype: v?.qtype ?? null,
      qtypeLabel: v?.qtype ? qtypeLabel(v.qtype) : "",
      difficultyLabel: v?.difficulty != null ? difficultyLabel(v.difficulty) : "",
      versionNo: v?.version_no ?? null,
      versionStatus: v?.status ?? null,
      // 内容任务摘要取题干；下线/恢复事件无内容版本 → 取题目当前入库版本题干
      summary: content
        ? blocksToText(content.stem)
        : q
          ? "(状态变更申请，见任务详情)"
          : "",
      questionState: q?.state ?? null,
      nodePath: nodePath(q?.course_node_id),
      schoolName: q ? schoolMap.get(q.school_id) ?? "" : "",
      creatorName: q ? userMap.get(q.creator_id) ?? "" : "",
      assignedName: a.assigned_user_id ? userMap.get(a.assigned_user_id) ?? "" : "",
      decidedByName: a.decided_by ? userMap.get(a.decided_by) ?? "" : "",
    }
  })
}
