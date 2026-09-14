// 我的题目工作台：行数据装载与合并（服务端 seed 与客户端刷新共用，实例参数区分 server/browser supabase）
import { blocksToText, qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { indexNodes, subjectNodesQuery } from "@/lib/subject-nodes"

export const INFLIGHT = ["draft", "pending_group", "pending_city", "returned"]

// 行展示状态：在流版本优先；无在流版本时看题目上下线态，再退到最新版本状态
function questionDisplayState(question, working, latest) {
  if (working) return working.status
  if (question.state === "offline") return "offline"
  return latest ? latest.status : "draft" // 无任何版本（理论不可达）
}

export async function loadMyQuestions(supabase, uid) {
  const { data: questions, error } = await supabase
    .from("questions")
    .select("id, school_id, course_node_id, state, created_at, current_published_version_id")
    .eq("creator_id", uid)
    .order("created_at", { ascending: false })
  if (error) throw error
  const qs = questions ?? []
  if (qs.length === 0) return { rows: [] }

  const [vRes, nRes, sRes, aRes] = await Promise.all([
    supabase
      .from("question_versions")
      .select(
        "id, question_id, version_no, change_type, status, qtype, difficulty, content, created_at, submitted_at, published_at"
      )
      .in(
        "question_id",
        qs.map((q) => q.id)
      )
      .order("version_no", { ascending: false }),
    subjectNodesQuery(supabase),
    supabase.from("schools").select("id, name").order("name"),
    // 在途的下线/恢复申请（题目级事件；有则隐藏重复按钮、显示“审批中”）
    supabase
      .from("approvals")
      .select("question_id, kind")
      .eq("state", "waiting")
      .in("kind", ["offline", "restore"])
      .in(
        "question_id",
        qs.map((q) => q.id)
      ),
  ])
  if (vRes.error) throw vRes.error
  const pendingStateReq = new Map()
  for (const a of aRes.data ?? []) {
    if (!pendingStateReq.has(a.question_id)) pendingStateReq.set(a.question_id, a.kind)
  }

  const versions = vRes.data ?? []
  const { byId: nodeById, pathOf: nodePath } = indexNodes(nRes.data)
  const schoolMap = new Map((sRes.data ?? []).map((s) => [s.id, s.name]))

  // 版本按题分组（查询已按 version_no 倒序 → 组内首个即最新），顺带收集在流版本用于查标签
  const versionsOfQuestion = new Map()
  const latestOf = new Map()
  const workIds = []
  for (const v of versions) {
    const arr = versionsOfQuestion.get(v.question_id)
    if (arr) arr.push(v)
    else versionsOfQuestion.set(v.question_id, [v])
    if (!latestOf.has(v.question_id)) latestOf.set(v.question_id, v)
    if (INFLIGHT.includes(v.status)) workIds.push(v.id)
  }
  const tagRes = workIds.length
    ? await supabase.from("version_tags").select("version_id, tag_name").in("version_id", workIds)
    : { data: [] }
  const tagsByVersion = new Map()
  for (const t of tagRes.data ?? []) {
    const arr = tagsByVersion.get(t.version_id) ?? []
    arr.push(t.tag_name)
    tagsByVersion.set(t.version_id, arr)
  }

  const rows = qs.map((q) => {
    const versionsOf = versionsOfQuestion.get(q.id) ?? []
    const working = versionsOf.find((v) => INFLIGHT.includes(v.status)) ?? null
    const latest = latestOf.get(q.id) ?? null
    const shown = working ?? latest
    return {
      question: q,
      working,
      latest,
      displayState: questionDisplayState(q, working, latest),
      shownVersion: shown,
      qtype: shown?.qtype ?? null,
      qtypeLabel: shown?.qtype ? qtypeLabel(shown.qtype) : "",
      difficulty: shown?.difficulty ?? null,
      difficultyLabel: shown?.difficulty != null ? difficultyLabel(shown.difficulty) : "",
      summary: shown?.content ? blocksToText(shown.content.stem) : "",
      nodePath: nodePath(q.course_node_id),
      nodeFrozen: nodeById.get(q.course_node_id)?.is_frozen ?? false,
      schoolName: schoolMap.get(q.school_id) ?? "",
      tags: shown ? (tagsByVersion.get(shown.id) ?? []) : [],
      changeType: shown?.change_type ?? null,
      // 改版中的版本（对已入库题发起的新版本）加注；已入库题本身仍在在线状态
      stateText: shown?.version_no
        ? `v${shown.version_no}${shown.change_type === "edit" && q.state === "live" ? " · 改版" : ""}`
        : "",
      // 在途的下线/恢复申请（'offline' | 'restore' | null）——隐藏按钮并展示“审批中”
      pendingStateReq: pendingStateReq.get(q.id) ?? null,
      // 仅"从未提交过任何版本"的纯草稿可删除（DB 收口，此处对齐展示）
      canDelete:
        (working?.status === "draft" || (!working && !latest)) &&
        versionsOf.length === 1 &&
        versionsOf[0].status === "draft",
    }
  })
  return { rows }
}

export const WORKBENCH_FILTERS = [
  { key: "all", label: "全部", match: () => true },
  { key: "draft", label: "草稿", match: (s) => s === "draft" },
  {
    key: "pending",
    label: "审核中",
    match: (s) => s === "pending_group" || s === "pending_city",
  },
  { key: "returned", label: "已退回", match: (s) => s === "returned" },
  { key: "live", label: "已入库", match: (s) => s === "published" },
  { key: "offline", label: "已下线", match: (s) => s === "offline" },
]
