// AI 辅助主观题评分的提示词与返回校验。
//
// 范围：0124（2026-11-03 口径）之后，**顶层 short_answer、顶层 fill_blank 与
// 顶层 composite 一律 pending**（复合题整题交教师阅卷），所以这里按
// "一道题 + N 个计分点"来设计，题型不只简答一种。
//
// ⚠ 计分点与子题的排布有好几种（每个空一个点 / 每个子题一个点 / 整题一个点），
// 对齐在 lib/grading-units.js；对齐不上时**也必须把学生作答带上**，
// 否则模型只会说「未作答」（2026-11-05 线上踩过）。
//
// 硬边界：
//   · 只输出建议，不写库；教师采纳后仍走原 grade_exam_answer；
//   · 每个评分点 0..max，总和不超过满分；
//   · 空白作答必须 0 分；
//   · evidence 必须引用学生答案或参考答案，不能编。
const DEFAULT_TOTAL = 10

function asArray(value) {
  return Array.isArray(value) ? value : []
}

export const SYSTEM_PROMPT = `你是中职阅卷教师。请按评分点给一道主观题打分。

只输出一个 json 对象，不要任何解释文字、不要 Markdown 代码块。对象结构：
{
  "units": [ { "index": 0, "score": 0, "max": 10, "reason": "为什么给这个分", "evidence": "引用学生答案或参考答案中的原文" } ],
  "confidence": 0.72,
  "comment": "给学生看的简短评语",
  "missing_points": ["学生漏掉的要点"],
  "caveats": "参考不足或不确定之处"
}

规则：
- 逐评分点给分；每个分数在 0 到 max 之间；所有评分点之和不超过满分；
- 只有全部关键点都正确、完整时才给满分；
- 按关键点给部分分，不要因为字迹/长度随意扣分；
- 每个 unit 的 mode 为 binary 时，分数只能 0 或 max；mode 为 partial 时可以给部分分；
- unit.blank 为 true 时必须 0 分；
- 空白或与题目无关的作答一律 0 分；
- 填空题按语义等价判断，接受同义表达；
- evidence 必须引用学生答案或参考答案中的原文（不超过 40 字），不要转述；
- 不出现学生姓名；comment 直接对学生说。`

export function buildGradingMessages({
  qtype = "short_answer",
  stem,
  referenceAnswers = [],
  analysis = "",
  unitLabels = [],
  maxUnits = [],
  totalScore = DEFAULT_TOTAL,
  studentAnswer = "",
  unitSpecs = null,
}) {
  // 填空/综合/简答统一走 unit specs：每个计分点带 mode/blank/参考答案/学生作答
  if (Array.isArray(unitSpecs) && unitSpecs.length > 0) {
    const payload = {
      qtype,
      stem,
      analysis,
      total_score: Number(totalScore) || DEFAULT_TOTAL,
      units: unitSpecs.map((unit) => ({
        index: unit.index,
        label: unit.label,
        kind: unit.kind,
        mode: unit.mode,
        max: Number(unit.max) || 0,
        prompt: unit.prompt,
        reference: asArray(unit.reference),
        alternatives: asArray(unit.alternatives),
        student: unit.student,
        blank: Boolean(unit.blank),
      })),
    }
    return [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `请逐 unit 判分，只输出 json 对象：\n${JSON.stringify(payload, null, 2)}`,
      },
    ]
  }

  const payload = {
    qtype: "short_answer",
    stem,
    reference_answers: asArray(referenceAnswers),
    analysis,
    units: asArray(maxUnits).map((max, index) => ({
      index,
      label: unitLabels[index] ?? `第 ${index + 1} 点`,
      max: Number(max) || 0,
    })),
    total_score: Number(totalScore) || DEFAULT_TOTAL,
    student_answer: studentAnswer,
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请判这道主观题，只输出 json 对象：\n${JSON.stringify(payload, null, 2)}`,
    },
  ]
}

/**
 * 校验模型返回。maxUnits 是每个评分点的上限（来自 paper_items.score_units）。
 * 返回 {ok:true, suggestion} 或 {ok:false, reason}。
 */
export function validateGradingSuggestion(
  value,
  { maxUnits = [], totalScore = DEFAULT_TOTAL, blank = false, unitSpecs = null } = {}
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "返回的不是对象" }
  }
  if (!Array.isArray(value.units)) {
    return { ok: false, reason: "units 不是数组" }
  }
  const specs =
    Array.isArray(unitSpecs) && unitSpecs.length > 0 ? unitSpecs : null
  const caps = specs ? specs.map((unit) => Number(unit.max) || 0) : asArray(maxUnits)
  if (caps.length === 0) {
    return { ok: false, reason: "没有评分点上限" }
  }

  const rawUnits = value.units
  let failure = ""
  const units = caps.map((cap, index) => {
    const spec = specs?.[index]
    const raw =
      rawUnits.find((item) => Number(item?.index) === index) ?? rawUnits[index] ?? {}
    const max = Number(cap) || 0
    const score = Number(raw.score)
    const reason = String(raw.reason ?? "").trim()
    if (!Number.isFinite(score) || score < 0 || score > max + 1e-9) {
      failure ||= "有评分点缺失或分数越界"
      return null
    }
    if (spec?.mode === "binary" && score !== 0 && score !== max) {
      failure ||= "客观评分点只能 0 或满分"
      return null
    }
    if (spec?.blank && score > 0) {
      failure ||= "空白评分点必须 0 分"
      return null
    }
    if (specs && score > 0 && !reason) {
      failure ||= "给分必须说明理由"
      return null
    }
    return {
      index,
      score: Math.round(score * 100) / 100,
      max,
      reason,
      evidence: String(raw.evidence ?? "").trim(),
    }
  })
  if (failure || units.some((item) => item == null)) {
    return { ok: false, reason: failure || "有评分点缺失或分数越界" }
  }

  const total = units.reduce((sum, item) => sum + item.score, 0)
  const limit = Number(totalScore) || units.reduce((sum, item) => sum + item.max, 0)
  if (total > limit + 1e-9) {
    return { ok: false, reason: `合计 ${total} 分超过满分 ${limit}` }
  }
  if (blank && units.some((item) => item.score > 0)) {
    return { ok: false, reason: "空白作答必须全部 0 分" }
  }

  let confidence = Number(value.confidence)
  if (!Number.isFinite(confidence)) confidence = 0.5
  confidence = Math.max(0, Math.min(1, confidence))

  return {
    ok: true,
    suggestion: {
      units,
      confidence,
      comment: String(value.comment ?? "").trim(),
      missing_points: asArray(value.missing_points)
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
      caveats: String(value.caveats ?? "").trim(),
    },
  }
}
