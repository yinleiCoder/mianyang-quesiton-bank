// 讲评教案的模板兜底（纯函数，无网络、无密钥）。
//
// 为什么必须有这一条：教案页的演示/使用不应依赖教师当场有没有 DeepSeek 密钥。
// 模板从已存的 AI 班级报告里取薄弱点、典型错误与行动方案，排成 45 分钟课堂时间线；
// 它不是"AI 生成"，所以 caveats 里必须写清楚，答辩时也不能把它算成模型能力。

const DEFAULT_DURATION = 45

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function seqOf(item) {
  const n = Number(item?.seq)
  return Number.isFinite(n) ? n : null
}

/** 把总时长按权重分配成整数分钟，最后一格兜住余数，保证合计精确等于 total。 */
export function scaleMinutes(total, weights) {
  const sum = weights.reduce((acc, value) => acc + value, 0)
  let remaining = total
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return Math.max(1, remaining)
    const value = Math.max(1, Math.round((total * weight) / sum))
    remaining -= value
    return value
  })
}

export function buildFallbackLessonPlan({
  report = {},
  paper = {},
  classInfo = {},
  summary = {},
  durationMinutes = DEFAULT_DURATION,
} = {}) {
  const duration = Math.max(20, Math.min(90, Number(durationMinutes) || DEFAULT_DURATION))
  const weak = asArray(report.weak_points)
  const errors = asArray(report.error_analysis)
  const notes = asArray(report.question_notes)
  const actions = asArray(report.action_plan)
  const keySource = errors.length > 0 ? errors : notes
  const keyPoints = keySource
    .map((item) => ({
      seq: seqOf(item),
      title: String(item.label ?? item.note ?? (item.seq ? `第 ${item.seq} 题` : "")).trim(),
      why: String(item.evidence ?? item.label ?? "").trim(),
      approach: String(item.suggestion ?? "先让学生说思路，再对照正确解法").trim(),
      evidence: String(item.evidence ?? "").trim(),
    }))
    .filter((item) => item.seq != null && item.title)
    .slice(0, 3)
  const seqText = keyPoints.map((item) => item.seq).join("、") || "本次错误最集中的几道题"
  const minutes = scaleMinutes(duration, [5, 10, 15, 8, 5])
  let start = 0
  const timeline = [
    {
      phase: "导入",
      teacher: `用 1 分钟说明本节要解决的两个问题；本次 ${Number(summary.participants) || 0} 人参加，用成绩分布图定位整体位置。`,
      students: "看自己的分数与班级位置。",
      materials: "成绩分布图",
    },
    {
      phase: "知识梳理",
      teacher: `梳理「${weak[0]?.point ?? "本节核心知识点"}」，把易混概念列成对照表。`,
      students: "补全笔记，标出自己不确定的条目。",
      materials: "板书 / 课件",
    },
    {
      phase: "典型错题讲评",
      teacher: `按第 ${seqText} 题讲；先让学生说思路，再给正确解法。`,
      students: "说出自己当时的想法；记录错误类型。",
      materials: "讲评大屏 / 原卷",
    },
    {
      phase: "变式训练",
      teacher: "给 2 道同知识点变式，限时完成，现场核对。",
      students: "独立完成，互批。",
      materials: "变式题单",
    },
    {
      phase: "小结与出口票",
      teacher: "用 2 个问题检查是否达成目标。",
      students: "写出出口票。",
      materials: "出口票",
    },
  ].map((phase, index) => {
    const item = { start_min: start, minutes: minutes[index], ...phase }
    start += minutes[index]
    return item
  })

  return {
    meta: {
      title: `讲评教案 · ${paper.title ?? "本次考试"}`,
      duration_minutes: duration,
      audience: classInfo.name ?? "班级",
      prerequisites: "学生已完成本次考试并拿到成绩单",
      source: "template",
    },
    objectives: [
      {
        knowledge: weak[0]?.point ?? "本次考试的核心知识点",
        ability: "能在同类题中识别并正确作答",
        literacy: "用证据（选项/原文）说明理由，而不是凭印象",
      },
    ],
    key_points: keyPoints,
    timeline,
    board_plan: [
      `左侧：${weak[0]?.point ?? "核心概念"} 的正误对照`,
      `右侧：第 ${seqText} 题的关键步骤与易错点`,
    ],
    differentiation: {
      support: actions[0]?.action ?? "先补最基础的概念与操作，允许看笔记完成",
      core: actions[1]?.action ?? "独立完成同知识点变式题",
      challenge: actions[2]?.action ?? "完成一道综合应用题，并说明每一步依据",
    },
    homework: {
      must: actions
        .slice(0, 2)
        .map((item) => String(item.action ?? "").trim())
        .filter(Boolean),
      choose: ["从错题本挑 2 道同知识点题重做", "把今天讲的关键步骤写成一张知识卡"],
      preview: "预习下一节相关知识点，标出看不懂的一处。",
    },
    exit_ticket: {
      questions: [
        "用一句话说出今天最容易混淆的两个概念的区别。",
        `重做第 ${keyPoints[0]?.seq ?? "一"} 题的关键步骤是什么？`,
      ],
      success_criteria: "出口票两题都能写出依据，且步骤完整。",
    },
    caveats: "模板生成：按报告中的薄弱点与典型错误编排，未使用大模型。",
  }
}
