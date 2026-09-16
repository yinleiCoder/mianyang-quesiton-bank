// 我的题目工作台：行数据装载与合并（服务端 seed 与客户端刷新共用，实例参数区分 server/browser supabase）
import { blocksToText, qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { indexNodes, subjectNodesQuery } from "@/lib/subject-nodes"
import { STAGE_LABELS } from "@/lib/review-workbench"

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
    // 本题的在途审批行，一次查全：
    //   · 下线/恢复申请（题目级事件）：有则隐藏重复按钮、显示“审批中”；
    //   · 内容任务：给作者显示卡在哪一步、谁在处理（作者可见这些行——0009 的
    //     select_approval 策略放行 is_question_creator；没有这一条，作者只能看到
    //     「专家审核中」四个字，任务其实没人处理也看不出来）。
    supabase
      .from("approvals")
      .select("id, question_id, kind, stage, assigned_user_id")
      .eq("state", "waiting")
      .in("kind", ["offline", "restore", "content"])
      .in(
        "question_id",
        qs.map((q) => q.id)
      ),
  ])
  if (vRes.error) throw vRes.error
  const pendingStateReq = new Map()
  const pendingContent = new Map()
  const assigneeIds = []
  for (const a of aRes.data ?? []) {
    if (a.kind === "content") {
      pendingContent.set(a.question_id, a)
      if (a.assigned_user_id) assigneeIds.push(a.assigned_user_id)
    } else if (!pendingStateReq.has(a.question_id)) {
      pendingStateReq.set(a.question_id, a.kind)
    }
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
  // 标签与处理人姓名并进同一个 Promise.all：两者都依赖上面的结果、彼此不依赖，
  // 串行 await 会白等一轮往返（这是每次打开「我的题目」都要走的路径）
  const [tagRes, peopleRes] = await Promise.all([
    workIds.length
      ? supabase.from("version_tags").select("version_id, tag_name").in("version_id", workIds)
      : { data: [] },
    assigneeIds.length
      ? supabase.from("profiles").select("user_id, name").in("user_id", assigneeIds)
      : { data: [] },
  ])
  const nameOf = new Map((peopleRes.data ?? []).map((p) => [p.user_id, p.name]))
  const tagsByVersion = new Map()
  for (const t of tagRes.data ?? []) {
    const arr = tagsByVersion.get(t.version_id) ?? []
    arr.push(t.tag_name)
    tagsByVersion.set(t.version_id, arr)
  }

  // 送出去之前摘掉 content：它是整题正文（题干/选项/媒体引用，可能几 KB），
  // 而一行最多挂 working/latest/shownVersion 三个版本对象，几十道题就能把 RSC 载荷
  // 顶到几百 KB —— 全仓对这些子对象只读四个字段（question.id / working.id /
  // working.status / shownVersion.version_no），正文根本用不上（Vercel 最佳实践
  // server-serialization，HIGH）。summary 已在上方由 content 算出，所以这里摘掉不影响展示。
  // 只去这一个键、其余原样保留：将来下游多读一个标量字段也不会因为这次瘦身而炸。
  const stripContent = (v) => {
    if (!v) return null
    const { content, ...rest } = v
    return rest
  }

  const rows = qs.map((q) => {
    const versionsOf = versionsOfQuestion.get(q.id) ?? []
    const working = versionsOf.find((v) => INFLIGHT.includes(v.status)) ?? null
    const latest = latestOf.get(q.id) ?? null
    const shown = working ?? latest
    return {
      question: q,
      working: stripContent(working),
      latest: stripContent(latest),
      displayState: questionDisplayState(q, working, latest),
      shownVersion: stripContent(shown),
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
      // 在途内容审批：卡在哪一步、谁在处理（assignedName 为空 = 任务待指派，没人能看见就没人会处理）
      pendingApproval: pendingContent.has(q.id)
        ? {
            id: pendingContent.get(q.id).id,
            stageLabel: STAGE_LABELS[pendingContent.get(q.id).stage] ?? pendingContent.get(q.id).stage,
            assignedName: pendingContent.get(q.id).assigned_user_id
              ? nameOf.get(pendingContent.get(q.id).assigned_user_id) ?? ""
              : "",
          }
        : null,
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
