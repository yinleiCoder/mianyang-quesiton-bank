// 学情问数：把一句话问题转成**受控查询意图**（不是 SQL）。
//
// 硬边界：
//   · 模型只能从白名单 intent 里选；params 里的 class_id 必须是当前班级；
//   · 模型不写 SQL、不接触数据库；客户端校验后调用现有只读 RPC；
//   · 摘要由模板根据 RPC 结果生成，不再二次调用模型（避免编造）；
//   · 不认识的意图返回 clarify，让页面给推荐问题，不猜。
import { nodePathOf } from "@/lib/subject-nodes"

export const ANALYTICS_INTENTS = {
  weak_nodes: {
    label: "班级弱项",
    context: "class",
    chart: "bar",
  },
  practice_trend: {
    label: "练习趋势",
    context: "class",
    chart: "line",
  },
  question_stats: {
    label: "试题正确率",
    context: "paper",
    chart: "table",
  },
  question_quality: {
    label: "试题质量",
    context: "paper",
    chart: "table",
  },
  leaderboard: {
    label: "成绩排行",
    context: "paper",
    chart: "table",
  },
  student_detail: {
    label: "学生学情",
    context: "student",
    chart: "table",
  },
}

export const ANALYTICS_INTENT_VALUES = Object.keys(ANALYTICS_INTENTS)
export const ANALYTICS_SCOPES = ["class", "school", "city", "province"]
const CHART_VALUES = ["bar", "line", "table"]

export const SYSTEM_PROMPT = `你是学情问数助手。把教师的一句话问题转成受控查询意图；你不写 SQL，也不直接回答数据。

只输出一个 json 对象，不要任何解释文字、不要 Markdown 代码块。对象结构：
{
  "intent": "weak_nodes|practice_trend|student_detail|null",
  "params": { "class_id": "uuid", "paper_id": "uuid", "student_id": "uuid", "days": 30 },
  "chart": "bar|line|table",
  "title": "一句话标题",
  "clarify": "信息不足或问题超出范围时问一句；否则为 null"
}

规则：
- intent 只能从 user 消息的 allowed_intents 里选；
- class_id 必须等于 current_class.id；paper_id 必须等于 current_paper.id；student_id 必须等于 current_student.id；days 在 7–90 之间；
- scope 只能是 class / school / city / province；不写就沿用 current_scope；
- 问知识点弱项用 weak_nodes；问练习量/趋势用 practice_trend；
- 问某个学生最近练得怎么样/最弱的知识点/错得最多的题用 student_detail；
- 问某道题正确率/最容易错的题用 question_stats；问区分度/干扰项用 question_quality；问排名用 leaderboard；
- 与 allowed_intents 无关的问题，intent 设为 null，并在 clarify 里说明“目前只能回答这些范围”；
- 不要编造数字；不要输出学生姓名。`

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function textOf(value) {
  return String(value ?? "").trim()
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 组 messages；intents 传本次可用的白名单（默认两条班级意图）。 */
export function buildAnalyticsIntentMessages({
  text,
  classInfo = null,
  paperInfo = null,
  studentInfo = null,
  scope = null,
  intents = ANALYTICS_INTENT_VALUES,
} = {}) {
  const payload = {
    request: textOf(text),
    allowed_intents: asArray(intents).map((value) => ({
      value,
      label: ANALYTICS_INTENTS[value]?.label ?? value,
      chart: ANALYTICS_INTENTS[value]?.chart ?? "table",
    })),
    current_class: classInfo
      ? { id: classInfo.id ?? null, name: classInfo.name ?? "" }
      : null,
    current_paper: paperInfo
      ? { id: paperInfo.id ?? null, title: paperInfo.title ?? "" }
      : null,
    // 只传 id，不把学生姓名发给模型。
    current_student: studentInfo ? { id: studentInfo.id ?? null } : null,
    current_scope: ANALYTICS_SCOPES.includes(scope) ? scope : null,
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请把下面这句话转成查询意图，只输出 json 对象：\n${JSON.stringify(payload, null, 2)}`,
    },
  ]
}

/**
 * 校验模型返回。返回 {ok:true,intent,clarify} 或 {ok:false,reason}。
 * intent 为 null 表示“超出范围”，页面据此显示推荐问题。
 */
export function validateAnalyticsIntent(
  value,
  {
    allowedIntents = ANALYTICS_INTENT_VALUES,
    classId = null,
    paperId = null,
    studentId = null,
    scope = null,
  } = {}
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "返回的不是对象" }
  }
  const clarify = textOf(value.clarify)
  const rawIntent = textOf(value.intent)
  if (!rawIntent || rawIntent === "null") {
    return {
      ok: true,
      intent: null,
      clarify:
        clarify ||
        "目前只能回答当前页面的学情范围；换一种问法试试。",
    }
  }
  if (!allowedIntents.includes(rawIntent)) {
    return { ok: false, reason: "意图不在允许列表里" }
  }

  const def = ANALYTICS_INTENTS[rawIntent]
  const rawParams = value.params ?? {}
  const params = {}
  if (def.context === "class") {
    const requested = textOf(rawParams.class_id)
    if (requested && classId && requested !== classId) {
      return { ok: false, reason: "班级参数与当前页面不一致" }
    }
    if (!classId) return { ok: false, reason: "当前页面没有班级上下文" }
    params.class_id = classId
  } else if (def.context === "paper") {
    const requested = textOf(rawParams.paper_id)
    if (requested && paperId && requested !== paperId) {
      return { ok: false, reason: "试卷参数与当前页面不一致" }
    }
    if (!paperId) return { ok: false, reason: "当前页面没有试卷上下文" }
    params.paper_id = paperId
    if (rawIntent === "question_stats" || rawIntent === "leaderboard") {
      const requestedScope = textOf(rawParams.scope)
      const nextScope = ANALYTICS_SCOPES.includes(requestedScope)
        ? requestedScope
        : ANALYTICS_SCOPES.includes(scope)
          ? scope
          : "class"
      params.scope = nextScope
      const requestedClass = textOf(rawParams.class_id)
      if (requestedClass && classId && requestedClass !== classId) {
        return { ok: false, reason: "班级参数与当前页面不一致" }
      }
      if (nextScope === "class" && classId) params.class_id = classId
    }
  } else if (def.context === "student") {
    const requested = textOf(rawParams.student_id)
    if (requested && studentId && requested !== studentId) {
      return { ok: false, reason: "学生参数与当前页面不一致" }
    }
    if (!studentId) return { ok: false, reason: "当前页面没有学生上下文" }
    params.student_id = studentId
  }
  if (rawIntent === "weak_nodes" || rawIntent === "practice_trend") {
    params.days = Math.min(90, Math.max(7, Math.round(numberOr(rawParams.days, 30))))
  }
  const chart = CHART_VALUES.includes(textOf(value.chart))
    ? textOf(value.chart)
    : def.chart
  return {
    ok: true,
    intent: {
      intent: rawIntent,
      params,
      chart,
      title: textOf(value.title) || def.label,
    },
    clarify: "",
  }
}

/** 弱项：课程节点正确率升序，取前 limit 个；名称用科目树路径。 */
export function buildWeakNodesRows(
  report,
  nodes,
  { limit = 5, minAttempts = 3 } = {}
) {
  const rows = asArray(report?.node_accuracy)
    .filter((row) => (Number(row?.attempts) || 0) >= minAttempts)
    .map((row) => {
      const attempts = Number(row?.attempts) || 0
      const correct = Number(row?.correct) || 0
      return {
        node_id: row?.node_id ?? "",
        name: nodePathOf(nodes ?? [], row?.node_id) || row?.node_id || "未命名知识点",
        attempts,
        correct,
        accuracy: attempts > 0 ? correct / attempts : null,
      }
    })
    .filter((row) => row.accuracy != null)
    .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
    .slice(0, limit)
  return rows
}

/** 弱项摘要：模板拼装，不调模型。 */
export function buildWeakNodesSummary(report, rows) {
  const days = Number(report?.window?.days) || 30
  if (!rows || rows.length === 0) {
    return `最近 ${days} 天没有足够的作答样本（每个知识点至少 3 次），暂时给不出弱项。`
  }
  const first = rows[0]
  const rest = rows
    .slice(1, 3)
    .map((row) => `${row.name}（${Math.round(row.accuracy * 100)}%）`)
    .join("、")
  return `最近 ${days} 天，最弱的知识点是 ${first.name}（正确率 ${Math.round(
    first.accuracy * 100
  )}%）${rest ? `；其次是 ${rest}` : ""}。建议先补这几个点。`
}

/** 趋势摘要：模板拼装。 */
export function buildPracticeSummary(report) {
  const p = report?.participation ?? {}
  const days = Number(report?.window?.days) || 30
  const students = Number(p.student_count) || 0
  const active = Number(p.active_count) || 0
  const answered = Number(p.answered_count) || 0
  const correct = Number(p.correct_count) || 0
  if (answered === 0) return `最近 ${days} 天班里还没有练习记录。`
  const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : null
  return `最近 ${days} 天，${active}/${students} 人参与，共作答 ${answered} 题，正确率 ${
    accuracy == null ? "—" : `${accuracy}%`
  }；练习天数 ${Number(p.practiced_days) || 0} 天。`
}

/** 趋势每日行（只取有作答的日子，避免空折线）。 */
export function buildPracticeTrendRows(report) {
  return asArray(report?.trend)
    .filter((row) => (Number(row?.answered) || 0) > 0)
    .map((row) => ({
      date: row?.date ?? "",
      answered: Number(row?.answered) || 0,
      correct: Number(row?.correct) || 0,
      accuracy:
        Number(row?.answered) > 0 ? (Number(row?.correct) || 0) / Number(row.answered) : null,
    }))
}

/** 试题正确率：已判分 ≥5 的题按正确率升序，附带最常选错项。 */
export function buildQuestionStatsRows(stats, { limit = 5, minGraded = 5 } = {}) {
  return asArray(stats?.items)
    .filter((item) => (Number(item?.graded) || 0) >= minGraded && item?.correct_rate != null)
    .map((item) => {
      const wrongOptions = asArray(item?.options)
        .filter((option) => !option?.is_answer && (Number(option?.count) || 0) > 0)
        .sort((a, b) => (Number(b?.count) || 0) - (Number(a?.count) || 0))
      const topWrong = wrongOptions[0] ?? null
      return {
        seq: item?.seq,
        qtype: item?.qtype ?? "",
        graded: Number(item?.graded) || 0,
        correct_rate: Number(item.correct_rate),
        top_wrong: topWrong
          ? `${topWrong.key ?? ""}. ${topWrong.text ?? ""}（${topWrong.count ?? 0} 人）`
          : null,
        top_texts: asArray(item?.text_counts)
          .slice(0, 3)
          .map((entry) => entry?.text)
          .filter(Boolean),
      }
    })
    .sort((a, b) => a.correct_rate - b.correct_rate || b.graded - a.graded)
    .slice(0, limit)
}

export function buildQuestionStatsSummary(stats, rows) {
  const attempts = Number(stats?.stats?.attempts) || 0
  if (!rows || rows.length === 0) {
    return "没有足够的已判分样本（每题至少 5 份）来比较正确率。"
  }
  const first = rows[0]
  return `共 ${attempts} 人参考；正确率最低的是第 ${first.seq} 题（${Math.round(
    first.correct_rate * 100
  )}%，${first.graded} 份已判分）${
    first.top_wrong ? `，最多人误选 ${first.top_wrong}` : ""
  }。`
}

/** 试题质量：区分度 r_pb 升序（最低的先看）；样本 <10 的题不列。 */
export function buildQuestionQualityRows(quality, { limit = 5, minSample = 10 } = {}) {
  return asArray(quality?.items)
    .filter((item) => item?.r_pb != null && (Number(item?.n) || 0) >= minSample)
    .map((item) => {
      const r = Number(item.r_pb)
      const p = item.p_value == null ? null : Number(item.p_value)
      return {
        seq: item?.seq,
        qtype: item?.qtype ?? "",
        n: Number(item?.n) || 0,
        p_value: p,
        r_pb: r,
        note:
          r < 0.2
            ? "区分度偏低"
            : r < 0.3
              ? "区分度一般"
              : p != null && p > 0.9
                ? "过易"
                : p != null && p < 0.3
                  ? "过难"
                  : null,
      }
    })
    .sort((a, b) => a.r_pb - b.r_pb || b.n - a.n)
    .slice(0, limit)
}

export function buildQuestionQualitySummary(quality, rows) {
  const note = String(quality?.summary?.note ?? "").trim()
  if (!rows || rows.length === 0) {
    return `没有足够的已判分样本（每题至少 10 份）来算区分度。${note ? ` ${note}` : ""}`
  }
  const first = rows[0]
  return `区分度最低的是第 ${first.seq} 题（r=${first.r_pb.toFixed(
    2
  )}，n=${first.n}）${first.note ? `，${first.note}` : ""}。${note ? ` ${note}` : ""}`
}

/** 成绩排行：按名次取前 limit 行。 */
export function buildLeaderboardRows(board, { limit = 10 } = {}) {
  return asArray(board?.rows)
    .slice(0, limit)
    .map((row) => ({
      rank: row?.rank,
      name: row?.name ?? "",
      score: row?.score,
      full_score: row?.full_score,
      percent: row?.percent == null ? null : Number(row.percent),
      duration_ms: row?.duration_ms,
      class_name: row?.class_name ?? "",
    }))
}

export function buildLeaderboardSummary(board, rows) {
  const label = board?.scope?.label ?? "当前范围"
  const total = Number(board?.stats?.total) || 0
  if (!rows || rows.length === 0) {
    return `${label}暂无已出分成绩。`
  }
  const first = rows[0]
  return `${label}共 ${total} 人上榜；第 1 名 ${first.name}，${first.score ?? "—"}/${
    first.full_score ?? "—"
  } 分${first.percent != null ? `（${Math.round(first.percent * 100)}%）` : ""}。`
}

/** 学生学情：知识点正确率升序（样本 ≥3），名称走科目树。 */
export function buildStudentDetailRows(
  detail,
  nodes,
  { limit = 5, minAttempts = 3 } = {}
) {
  return asArray(detail?.node_accuracy)
    .filter((row) => (Number(row?.attempts) || 0) >= minAttempts)
    .map((row) => {
      const attempts = Number(row?.attempts) || 0
      const correct = Number(row?.correct) || 0
      return {
        node_id: row?.node_id ?? "",
        name: nodePathOf(nodes ?? [], row?.node_id) || row?.node_id || "未命名知识点",
        attempts,
        correct,
        accuracy: attempts > 0 ? correct / attempts : null,
      }
    })
    .filter((row) => row.accuracy != null)
    .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
    .slice(0, limit)
}

/** 学生错得最多的题：按 wrong_count 降序。 */
export function buildStudentDetailWrongRows(detail, { limit = 5 } = {}) {
  return asArray(detail?.wrong_questions)
    .map((row) => ({
      question_id: row?.question_id ?? "",
      stem: String(row?.stem_text ?? "").trim().slice(0, 50) || "（无题干）",
      qtype: row?.qtype ?? "",
      wrong_count: Number(row?.wrong_count) || 0,
    }))
    .sort((a, b) => b.wrong_count - a.wrong_count)
    .slice(0, limit)
}

export function buildStudentDetailSummary(detail, rows, wrongRows = []) {
  const name = String(detail?.student?.name ?? "").trim() || "该学生"
  const totals = asArray(detail?.node_accuracy).reduce(
    (acc, row) => ({
      attempts: acc.attempts + (Number(row?.attempts) || 0),
      correct: acc.correct + (Number(row?.correct) || 0),
    }),
    { attempts: 0, correct: 0 }
  )
  if (!rows || rows.length === 0) {
    return `${name}的练习样本还不够（每个知识点至少 3 次），暂时给不出弱项。`
  }
  const first = rows[0]
  const accuracy =
    totals.attempts > 0 ? Math.round((totals.correct / totals.attempts) * 100) : null
  const wrong = wrongRows[0]
  return `${name}共作答 ${totals.attempts} 次${
    accuracy == null ? "" : `，正确率 ${accuracy}%`
  }；最弱的知识点是 ${first.name}（${Math.round(first.accuracy * 100)}%）${
    wrong ? `；错得最多的是「${wrong.stem}」（${wrong.wrong_count} 次）` : ""
  }。`
}
