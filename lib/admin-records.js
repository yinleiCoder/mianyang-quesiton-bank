// 管理端记录页数据装载（系统管理员 /admin/reviews 审批记录、/admin/audit 审计日志）
// 可见性交给 RLS（管理员策略可见全量）；行外字段装配与服务端 seed 模式一致。
import { blocksToText, qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { indexNodes, subjectNodesQuery } from "@/lib/subject-nodes"
import { KIND_LABELS, STAGE_LABELS } from "@/lib/review-workbench"
import { FEEDBACK_CATEGORIES, FEEDBACK_PLATFORMS } from "@/lib/feedback"

export const APPROVAL_STATES = {
  waiting: { text: "待处理", cls: "bg-amber-100 text-amber-700" },
  approved: { text: "已通过", cls: "bg-emerald-100 text-emerald-700" },
  returned: { text: "已退回", cls: "bg-rose-100 text-rose-700" },
  cancelled: { text: "已取消", cls: "bg-muted text-muted-foreground" },
}
export const approvalStateChip = (s) => APPROVAL_STATES[s] ?? { text: s, cls: "bg-muted text-muted-foreground" }

export const AUDIT_ACTION_LABELS = {
  create_draft: "创建草稿",
  update_draft: "修改草稿",
  submit_version: "提交审核",
  retract_version: "撤回提交",
  delete_draft: "删除草稿",
  request_offline: "申请下线",
  request_restore: "申请恢复",
  review_return: "审批退回",
  approve_group: "组长通过",
  approve_city_publish: "专家通过入库",
  approve_offline: "下线通过",
  approve_restore: "恢复通过",
  transfer_approval: "转派任务",
  // 0042 起：任命生效时自动把「待指派」的在途任务补上处理人
  backfill_assignee: "补指派处理人",
  admin_direct_update: "管理员直编",
  admin_offline: "管理员下线",
  admin_restore: "管理员恢复",
  override_inflight: "覆盖在流版本",
  submit_feedback: "提交意见反馈",
  handle_feedback: "处理意见反馈",
  // AI 解析（题库资料的批量导入）：逐题入库复用 create_draft（detail 带 import_job_id），
  // 任务级动作单独标
  import_create_job: "创建 AI 解析任务",
  import_finish_job: "AI 解析入库完成",
  import_discard_job: "放弃 AI 解析任务",
}

// 意见反馈事件不挂题目（question_id/version_id 均为空），摘要只能从 detail 里的快照字段拼，
// 否则审计页会显示成「（题目 -，无内容摘要）」。
function feedbackSummary(log) {
  const d = log.detail ?? {}
  if (!d.feedback_id) return ""
  const parts = [
    FEEDBACK_CATEGORIES[d.category],
    FEEDBACK_PLATFORMS[d.platform],
    d.status === "resolved" ? "已处理" : d.status === "open" ? "重新打开" : null,
  ].filter(Boolean)
  return parts.length ? `意见反馈（${parts.join(" · ")}）` : "意见反馈"
}

function mapsOf(list, keyFn) {
  return new Map((list ?? []).map((x) => [keyFn(x), x]))
}

// 审批记录：approvals 全量（按 state 过滤可选），补题目摘要/人名/学校/节点路径
export async function loadReviewRecords(supabase, { state = "all", limit = 80 } = {}) {
  let q = supabase
    .from("approvals")
    .select("id, kind, stage, state, created_at, decided_at, comment, version_id, question_id, assigned_user_id, decided_by")
  if (state !== "all") q = q.eq("state", state)
  q = q.order("created_at", { ascending: false }).limit(limit)
  const res = await q
  if (res.error) throw res.error
  const approvals = res.data ?? []
  if (approvals.length === 0) return []

  const vIds = [...new Set(approvals.map((a) => a.version_id).filter(Boolean))]
  const qIds = [...new Set(approvals.map((a) => a.question_id).filter(Boolean))]
  const uIds = [...new Set(approvals.flatMap((a) => [a.assigned_user_id, a.decided_by]).filter(Boolean))]
  const [vRes, qRes, nRes, sRes, pRes] = await Promise.all([
    vIds.length
      ? supabase
          .from("question_versions")
          .select("id, version_no, status, qtype, difficulty, content")
          .in("id", vIds)
      : { data: [] },
    qIds.length
      ? supabase
          .from("questions")
          .select("id, school_id, course_node_id, state, creator_id")
          .in("id", qIds)
      : { data: [] },
    subjectNodesQuery(supabase),
    supabase.from("schools").select("id, name"),
    uIds.length ? supabase.from("profiles").select("user_id, name").in("user_id", uIds) : { data: [] },
  ])
  for (const r of [vRes, qRes]) if (r.error) throw r.error

  const { pathOf: nodePath } = indexNodes(nRes.data)
  const schoolById = mapsOf(sRes.data, (s) => s.id)
  const userById = mapsOf(pRes.data, (p) => p.user_id)
  const versionById = mapsOf(vRes.data, (v) => v.id)
  const questionById = mapsOf(qRes.data, (q) => q.id)

  return approvals.map((a) => {
    const v = a.version_id ? versionById.get(a.version_id) : null
    const q = questionById.get(a.question_id)
    return {
      id: a.id,
      kind: a.kind,
      kindLabel: KIND_LABELS[a.kind] ?? a.kind,
      stage: a.stage,
      stageLabel: STAGE_LABELS[a.stage] ?? a.stage,
      state: a.state,
      createdAt: a.created_at,
      decidedAt: a.decided_at,
      comment: a.comment,
      assignedUserId: a.assigned_user_id,
      questionId: a.question_id,
      summary: v?.content
        ? blocksToText(v.content.stem)
        : q
          ? "(状态变更申请)"
          : "（题目已删除）",
      qtypeLabel: v?.qtype ? qtypeLabel(v.qtype) : "",
      difficultyLabel: v?.difficulty != null ? difficultyLabel(v.difficulty) : "",
      versionNo: v?.version_no ?? null,
      versionStatus: v?.status ?? null,
      nodePath: nodePath(q?.course_node_id),
      schoolName: q ? (schoolById.get(q.school_id)?.name ?? "") : "",
      creatorName: q ? (userById.get(q.creator_id)?.name ?? "") : "",
      assignedName: a.assigned_user_id ? (userById.get(a.assigned_user_id)?.name ?? "") : "",
      decidedByName: a.decided_by ? (userById.get(a.decided_by)?.name ?? "") : "",
    }
  })
}

// 审计日志：audit_log 最近 limit 条，补操作人姓名与题干摘要。
// 摘要来源：日志挂的版本内容优先（版本持久保存）；无版本的题目级事件（上下线等）取当前入库版本。
const stemOf = (content) => blocksToText(content?.stem) || "（无题干）"

export async function loadAuditRows(supabase, { limit = 200 } = {}) {
  const res = await supabase
    .from("audit_log")
    .select("id, user_id, question_id, version_id, action, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (res.error) throw res.error
  const logs = res.data ?? []
  if (logs.length === 0) return []

  const uIds = [...new Set(logs.map((l) => l.user_id).filter(Boolean))]
  const vIds = [...new Set(logs.map((l) => l.version_id).filter(Boolean))]
  const qIds = [...new Set(logs.map((l) => l.question_id).filter(Boolean))]
  const [pRes, vRes, qRes] = await Promise.all([
    uIds.length ? supabase.from("profiles").select("user_id, name").in("user_id", uIds) : { data: [] },
    vIds.length
      ? supabase.from("question_versions").select("id, content").in("id", vIds).limit(500)
      : { data: [] },
    qIds.length
      ? supabase
          .from("questions")
          .select("id, current_published_version_id")
          .in("id", qIds)
          .limit(500)
      : { data: [] },
  ])
  for (const r of [pRes, vRes, qRes]) if (r.error) throw r.error
  const userById = mapsOf(pRes.data, (p) => p.user_id)
  const contentByVersion = mapsOf(vRes.data, (v) => v.content)
  const pointerByQuestion = mapsOf(qRes.data, (q) => q.id)

  // 无 version_id 的事件（上下线/转派…）→ 题目当前入库版本的题干（题目可能已删除 → 指针缺失）
  const pointerIds = [...new Set((qRes.data ?? []).map((q) => q.current_published_version_id).filter(Boolean))]
  const curRes = pointerIds.length
    ? await supabase.from("question_versions").select("id, content").in("id", pointerIds)
    : { data: [] }
  const curByVersion = mapsOf(curRes.data, (v) => v.content)

  return logs.map((l) => {
    const snapContent = l.version_id ? contentByVersion.get(l.version_id) : undefined
    const pointerId = l.question_id ? pointerByQuestion.get(l.question_id)?.current_published_version_id : null
    const summary = snapContent
      ? stemOf(snapContent)
      : l.question_id && pointerId && curByVersion.get(pointerId)
        ? stemOf(curByVersion.get(pointerId))
        : feedbackSummary(l)
    return {
      id: l.id,
      action: l.action,
      actionLabel: AUDIT_ACTION_LABELS[l.action] ?? l.action,
      actorName: l.user_id ? (userById.get(l.user_id)?.name ?? "") : "（系统）",
      createdAt: l.created_at,
      questionId: l.question_id,
      summary,
      detailText: JSON.stringify(l.detail ?? {}),
    }
  })
}
