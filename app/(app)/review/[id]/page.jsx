// 审批详情：服务端聚合任务/题目/版本/时间线/转派候选，客户端负责决策动作。
// 可见性受 RLS 约束：任务处理人/决策人/作者/本校管理员/系统管理员可见；其余人 404 语义。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { AccessDenied } from "@/components/access-denied"
import { ReviewDetail } from "@/components/review/review-detail"
import { KIND_LABELS, STAGE_LABELS } from "@/lib/review-workbench"
import { qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { indexNodes } from "@/lib/subject-nodes"
import { loadSubjectNodes } from "@/lib/reference-data"
import { toISO } from "@/lib/format"

export const metadata = { title: "审批详情" }

const APPROVAL_COLUMNS =
  "id, kind, stage, state, created_at, decided_at, comment, assigned_user_id, decided_by"
const CANDIDATE_COLUMNS = "user_id, name, school_id"

export default async function ReviewDetailPage({ params }) {
  const { id } = await params
  const ctx = await requireUser()
  const supabase = await createClient()

  const { data: approval, error } = await supabase
    .from("approvals")
    .select("id, kind, stage, state, created_at, decided_at, comment, version_id, question_id, assigned_user_id, decided_by")
    .eq("id", id)
    .maybeSingle()
  if (error || !approval) {
    return <AccessDenied title="审批任务不存在或无权查看" description="该任务可能不属于你（转派后原处理人不再可见），或已被清理。" />
  }

  const { data: question } = await supabase
    .from("questions")
    .select("id, school_id, course_node_id, state, creator_id, current_published_version_id")
    .eq("id", approval.question_id)
    .maybeSingle()
  if (!question) return <AccessDenied title="题目不存在" />

  // 内容任务展示挂载版本；下线/恢复事件展示题目当前入库版本内容（申请目的=让审批人看到现状）
  const contentKind = approval.kind === "content"
  const showVersionId = contentKind ? approval.version_id : question.current_published_version_id

  const [vRes, tlRes, nodes, sRes] = await Promise.all([
    showVersionId
      ? supabase
          .from("question_versions")
          .select("id, version_no, status, qtype, difficulty, content, created_at, submitted_at, published_at, created_by")
          .eq("id", showVersionId)
          .maybeSingle()
      : { data: null },
    // 内容任务：同版本的全部审批行；上下线事件：同题目的全部事件行
    (contentKind
      ? supabase.from("approvals").select(APPROVAL_COLUMNS).eq("version_id", approval.version_id)
      : supabase
          .from("approvals")
          .select(APPROVAL_COLUMNS)
          .eq("question_id", question.id)
          .is("version_id", null)
    ).order("created_at", { ascending: true }),
    loadSubjectNodes(),
    supabase.from("schools").select("id, name"),
  ])

  const version = vRes.data
  const timeline = tlRes.data ?? []
  const { byId: nodeMap, pathOf: nodePath } = indexNodes(nodes)
  const schoolMap = new Map((sRes.data ?? []).map((s) => [s.id, s.name]))

  // 人名聚合：作者/处理人/决策人
  const uidSet = new Set([question.creator_id, approval.assigned_user_id, approval.decided_by])
  for (const t of timeline) {
    if (t.assigned_user_id) uidSet.add(t.assigned_user_id)
    if (t.decided_by) uidSet.add(t.decided_by)
  }
  const pRes = await supabase.from("profiles").select("user_id, name").in("user_id", [...uidSet])
  const userMap = new Map((pRes.data ?? []).map((p) => [p.user_id, p.name]))

  // 转派候选人 id：group=本校组长（无则本校成员）；city=全市在职专家
  let candidateIds = []
  if (approval.state === "waiting") {
    const baseAssign = () =>
      supabase.from("approver_assignments").select("user_id").eq("is_active", true)
    if (approval.stage === "group") {
      const { data: leaders } = await baseAssign()
        .eq("school_id", question.school_id)
        .eq("role", "group_leader")
      candidateIds = (leaders ?? []).map((l) => l.user_id)
      if (candidateIds.length === 0) {
        const { data: members } = await supabase
          .from("profiles")
          .select("user_id")
          .eq("school_id", question.school_id)
        candidateIds = (members ?? []).map((m) => m.user_id)
      }
    } else {
      const { data: experts } = await baseAssign().eq("role", "city_expert")
      candidateIds = (experts ?? []).map((e) => e.user_id)
    }
    candidateIds = [...new Set(candidateIds)]
  }
  const { data: candidatePeople } = candidateIds.length
    ? await supabase.from("profiles").select(CANDIDATE_COLUMNS).in("user_id", candidateIds)
    : { data: [] }
  const candidates = (candidatePeople ?? []).map((p) => ({
    user_id: p.user_id,
    name: p.name ?? "",
    schoolName: schoolMap.get(p.school_id) ?? "",
  }))

  // 版本标签快照
  let tagNames = []
  if (showVersionId) {
    const { data: tags } = await supabase
      .from("version_tags")
      .select("tag_name")
      .eq("version_id", showVersionId)
    tagNames = (tags ?? []).map((t) => String(t.tag_name))
  }

  const isSchoolAdminOfQ =
    ctx.isSchoolAdmin && ctx.profile?.school_id != null && ctx.profile.school_id === question.school_id

  return (
    <ReviewDetail
      data={{
        meId: ctx.user.id,
        canAct: approval.state === "waiting" && approval.assigned_user_id === ctx.user.id,
        canTransfer: approval.state === "waiting" && (ctx.isAdmin || (approval.stage === "group" && isSchoolAdminOfQ)),
        isAdmin: ctx.isAdmin,
        approval: {
          id: approval.id,
          kind: approval.kind,
          kindLabel: KIND_LABELS[approval.kind] ?? approval.kind,
          stage: approval.stage,
          stageLabel: STAGE_LABELS[approval.stage] ?? approval.stage,
          state: approval.state,
          createdAt: toISO(approval.created_at),
          comment: approval.comment,
          assignedUserId: approval.assigned_user_id,
          assignedName: approval.assigned_user_id ? userMap.get(approval.assigned_user_id) ?? "" : "",
          decidedBy: approval.decided_by,
          decidedByName: approval.decided_by ? userMap.get(approval.decided_by) ?? "" : "",
          decidedAt: toISO(approval.decided_at),
        },
        question: {
          id: question.id,
          creatorId: question.creator_id,
          state: question.state,
          nodePath,
          schoolName: schoolMap.get(question.school_id) ?? "",
          creatorName: userMap.get(question.creator_id) ?? "已注销",
          courseNodeName: nodeMap.get(question.course_node_id)?.name ?? "",
        },
        version: version
          ? {
              id: version.id,
              versionNo: version.version_no,
              status: version.status,
              qtype: version.qtype,
              qtypeLabel: qtypeLabel(version.qtype),
              difficulty: version.difficulty,
              difficultyLabel: difficultyLabel(version.difficulty),
              content: version.content,
              submittedAt: toISO(version.submitted_at),
              publishedAt: toISO(version.published_at),
            }
          : null,
        tags: tagNames,
        timeline: timeline.map((t) => ({
          id: t.id,
          kind: t.kind,
          stage: t.stage,
          state: t.state,
          comment: t.comment,
          assignedUserId: t.assigned_user_id,
          assignedName: t.assigned_user_id ? userMap.get(t.assigned_user_id) ?? "" : "",
          decidedBy: t.decided_by,
          decidedByName: t.decided_by ? userMap.get(t.decided_by) ?? "" : "",
          createdAt: toISO(t.created_at),
          decidedAt: toISO(t.decided_at),
        })),
        candidates,
        selfName: ctx.profile?.name ?? "",
      }}
    />
  )
}
