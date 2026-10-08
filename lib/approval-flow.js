// 审批链的状态推导与"流程图"节点数据。题目审批（components/review/review-detail.jsx）
// 与试卷审批（components/papers/paper-review-detail.jsx）共用这一份。
//
// 为什么必须共用：同一个老师在两处看到的"当前环节"不该不一样。此前两边各写一遍，
// 改一边忘一边是迟早的事。
//
// 为什么要推导而不是直接读审批行：RLS 只把与当前用户相关的行给他——组长看不到专家
// 那一行、专家看不到组长的通过行。所以「查不到行」不等于「流程断了」，
// 末尾要用版本状态兜底，这也是 chain 里各字段可能为 null 的原因。

// 一条审批链的"当前样子"。kind 传 null 表示不过滤（试卷的表里没有 kind 字段）。
export function deriveChain(timeline, kind = "content") {
  const byTime = (timeline ?? [])
    .filter((t) => kind == null || t.kind === kind)
    .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)))
  const last = (stage) => byTime.findLast((t) => t.stage === stage) ?? null
  const group = last("group")
  const city = last("city")
  // 撤回/重审的取消行只在它是当前最新事件时提示（旧代际的取消历史留在时间线里）
  const cancelledBy = byTime.at(-1)?.state === "cancelled" ? byTime.at(-1) : null
  return { group, city, cancelledBy }
}

// 审批行 → 节点状态：已决按结果，未决即"当前待办"，无行时用兜底值
export function stepState(row, fallback = "") {
  if (!row) return fallback
  if (row.state === "approved") return "done"
  if (row.state === "returned") return "halted"
  return "current"
}

// 题目入库（content）的链：教师提交 → 教研组长 → 市级专家 → 入库
export function contentFlowSteps({ chain, version, creatorName, stage, state, assignedLabel }) {
  const published = chain.published
  return [
    { id: "submit", label: "教师提交", state: "done", by: creatorName, at: version?.submittedAt },
    {
      id: "group",
      label: "教研组长审核",
      // 组长那一行不可见但已经进了专家环节 → 视为已通过
      state: stepState(chain.group, chain.city ? "done" : "current"),
      by: chain.group?.decidedByName,
      at: chain.group?.decidedAt,
      comment: chain.group?.comment,
      assigned: stage === "group" && state === "waiting" ? assignedLabel : undefined,
    },
    {
      id: "city",
      label: "市级专家审核",
      state: stepState(
        chain.city,
        chain.group?.state === "approved" || (chain.group?.state !== "returned" && published) ? "current" : ""
      ),
      by: chain.city?.decidedByName,
      at: chain.city?.decidedAt,
      comment: chain.city?.comment,
      assigned: stage === "city" && state === "waiting" ? assignedLabel : undefined,
    },
    {
      id: "publish",
      label: "入库",
      state: published ? "done" : "",
      by: published ? "系统自动" : null,
      at: version?.publishedAt,
    },
  ]
}

// 下线申请 / 恢复上线的链：发起申请 → 环节审核 → 生效
export function requestFlowSteps({ approval, creatorName, assignedLabel }) {
  const done = approval.state === "approved"
  return [
    { id: "apply", label: "发起申请", state: "done", by: creatorName, at: approval.createdAt },
    {
      id: "review",
      label: `${approval.stageLabel}审核`,
      state: stepState(approval),
      by: approval.decidedByName,
      at: approval.decidedAt,
      comment: approval.comment,
      assigned: approval.state === "waiting" ? assignedLabel : undefined,
    },
    {
      id: "effect",
      label: `题目${approval.kind === "offline" ? "下线" : "恢复上线"}`,
      state: done ? "done" : "",
      by: done ? "系统自动" : null,
    },
  ]
}

// 试卷的链与题目同形（试卷也走两级），差别只在两处：审批表没有 kind 字段，
// 以及"是否入库"要看试卷版本状态而不是题目版本。
export function paperFlowSteps({ timeline, version, creatorName, stage, state, assignedLabel }) {
  const chain = {
    ...deriveChain(timeline, null),
    published: version?.status === "published" || version?.status === "superseded",
  }
  return contentFlowSteps({ chain, version, creatorName, stage, state, assignedLabel }).map((s) =>
    // 试卷版本上没有"提交时刻"字段，退回用第一条审批行的创建时间
    s.id === "submit" ? { ...s, at: s.at ?? timeline?.[0]?.createdAt } : s
  )
}
