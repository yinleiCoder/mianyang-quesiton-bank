// AI 讲评教案的提示词与返回校验。
//
// 与其它提示词同一条规矩：SYSTEM_PROMPT 逐字节稳定，报告/班级数据只放 user 消息。
// 返回校验守住三件事：
//   · 时间线合计必须接近用户给的时长（模型很容易少排 5 分钟）；
//   · key_points 的题号必须来自报告，不能发明"第 12 题"；
//   · 出口票必须可观察，否则教案落不了地。
const DEFAULT_DURATION = 45

function asArray(value) {
  return Array.isArray(value) ? value : []
}

export const SYSTEM_PROMPT = `你是中职教研员，把一次考试的班级分析转成 40–45 分钟的讲评教案。

只输出一个 json 对象，不要任何解释文字、不要 Markdown 代码块。对象结构：
{
  "meta": { "title": "教案标题", "duration_minutes": 45, "audience": "班级", "prerequisites": "课前准备" },
  "objectives": [ { "knowledge": "知识目标", "ability": "能力目标", "literacy": "素养目标" } ],
  "key_points": [ { "seq": 5, "title": "关键题标题", "why": "为什么讲这道题", "approach": "课堂怎么讲", "evidence": "依据" } ],
  "timeline": [ { "start_min": 0, "minutes": 5, "phase": "导入", "teacher": "教师动作", "students": "学生动作", "materials": "材料" } ],
  "board_plan": ["板书要点"],
  "differentiation": { "support": "支持层", "core": "核心层", "challenge": "挑战层" },
  "homework": { "must": ["必做"], "choose": ["选做"], "preview": "预习" },
  "exit_ticket": { "questions": ["出口票问题"], "success_criteria": "可观察的达成标准" },
  "caveats": "数据不足或不确定之处"
}

规则：
- timeline 的 minutes 合计必须等于用户给的时长（误差不超过 3 分钟）；
- key_points 的 seq 必须来自报告里的题目序号，不要发明题号；
- 只使用报告与班级数据，不要编造课程进度；
- 报告里可能有学生姓名；可以沿用报告中的姓名，但不要新增或编造姓名；
- 每个 key_points 的 approach 必须是具体的课堂动作；
- exit_ticket 必须可观察、可验证。`

/** 报告里出现过的题号，供校验"不要发明题号"。 */
export function collectReportSeqs(report) {
  const seqs = new Set()
  for (const key of ["error_analysis", "question_notes", "key_points"]) {
    for (const item of asArray(report?.[key])) {
      const seq = Number(item?.seq)
      if (Number.isFinite(seq)) seqs.add(seq)
    }
  }
  return [...seqs]
}

export function buildLessonPlanMessages({
  report,
  paper = {},
  classInfo = {},
  summary = {},
  durationMinutes = DEFAULT_DURATION,
}) {
  const payload = {
    paper: {
      title: paper.title ?? "",
      exam_name: paper.exam_name ?? "",
      subject_label: paper.subject_label ?? "",
    },
    class: {
      name: classInfo.name ?? "",
      student_count: Number(classInfo.student_count) || 0,
      participants: Number(classInfo.participants) || 0,
    },
    summary: {
      avg_percent: summary.avg_percent ?? null,
      median_percent: summary.median_percent ?? null,
      pass_rate: summary.pass_rate ?? null,
    },
    duration_minutes: Math.max(20, Math.min(90, Number(durationMinutes) || DEFAULT_DURATION)),
    report,
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请根据下面的班级报告生成讲评教案，只输出 json 对象：\n${JSON.stringify(payload, null, 2)}`,
    },
  ]
}

function normalizeTimeline(raw) {
  let start = 0
  return asArray(raw).map((phase) => {
    const minutes = Math.max(1, Math.round(Number(phase?.minutes) || 0))
    const explicitStart = Number(phase?.start_min)
    const item = {
      start_min: Number.isFinite(explicitStart) ? explicitStart : start,
      minutes,
      phase: String(phase?.phase ?? "").trim(),
      teacher: String(phase?.teacher ?? "").trim(),
      students: String(phase?.students ?? "").trim(),
      materials: String(phase?.materials ?? "").trim(),
    }
    start = item.start_min + minutes
    return item
  })
}

/**
 * 校验模型返回的教案。失败返回 {ok:false, reason}，页面据此提示重试；
 * 成功返回归一化后的 plan（页面直接渲染）。
 */
export function validateLessonPlan(value, { durationMinutes = DEFAULT_DURATION, seqs = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "返回的不是对象" }
  }
  const duration = Math.max(20, Math.min(90, Number(durationMinutes) || DEFAULT_DURATION))
  const meta = value.meta && typeof value.meta === "object" ? value.meta : null
  if (!meta || !String(meta.title ?? "").trim()) {
    return { ok: false, reason: "缺少 meta.title" }
  }
  const objectives = asArray(value.objectives)
  if (objectives.length === 0) return { ok: false, reason: "objectives 为空" }

  const timeline = normalizeTimeline(value.timeline)
  if (timeline.length < 3) return { ok: false, reason: "timeline 少于 3 段" }
  const total = timeline.reduce((sum, phase) => sum + phase.minutes, 0)
  if (Math.abs(total - duration) > 5) {
    return { ok: false, reason: `timeline 合计 ${total} 分钟，与 ${duration} 分钟相差超过 5` }
  }

  let keyPoints = asArray(value.key_points).map((item) => ({
    seq: Number(item?.seq),
    title: String(item?.title ?? "").trim(),
    why: String(item?.why ?? "").trim(),
    approach: String(item?.approach ?? "").trim(),
    evidence: String(item?.evidence ?? "").trim(),
  }))
  keyPoints = keyPoints.filter((item) => Number.isFinite(item.seq) && item.title)
  if (keyPoints.length === 0) return { ok: false, reason: "key_points 为空或题号不合法" }
  if (seqs.length > 0) {
    keyPoints = keyPoints.filter((item) => seqs.includes(item.seq))
    if (keyPoints.length === 0) return { ok: false, reason: "key_points 的题号都不在报告里" }
  }

  const exitQuestions = asArray(value.exit_ticket?.questions)
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
  if (exitQuestions.length === 0) return { ok: false, reason: "exit_ticket.questions 为空" }

  return {
    ok: true,
    plan: {
      meta: {
        title: String(meta.title).trim(),
        duration_minutes: Number(meta.duration_minutes) || duration,
        audience: String(meta.audience ?? "").trim(),
        prerequisites: String(meta.prerequisites ?? "").trim(),
        source: "ai",
      },
      objectives: objectives.map((item) => ({
        knowledge: String(item?.knowledge ?? "").trim(),
        ability: String(item?.ability ?? "").trim(),
        literacy: String(item?.literacy ?? "").trim(),
      })),
      key_points: keyPoints,
      timeline,
      board_plan: asArray(value.board_plan).map((item) => String(item ?? "").trim()).filter(Boolean),
      differentiation: {
        support: String(value.differentiation?.support ?? "").trim(),
        core: String(value.differentiation?.core ?? "").trim(),
        challenge: String(value.differentiation?.challenge ?? "").trim(),
      },
      homework: {
        must: asArray(value.homework?.must).map((item) => String(item ?? "").trim()).filter(Boolean),
        choose: asArray(value.homework?.choose).map((item) => String(item ?? "").trim()).filter(Boolean),
        preview: String(value.homework?.preview ?? "").trim(),
      },
      exit_ticket: {
        questions: exitQuestions,
        success_criteria: String(value.exit_ticket?.success_criteria ?? "").trim(),
      },
      caveats: String(value.caveats ?? "").trim(),
    },
  }
}
