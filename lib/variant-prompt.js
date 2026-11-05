// AI 变式题的提示词与返回校验。
//
// 硬边界：
//   · 只生成草稿，**永不自动发布**；入库仍走 create_question_draft → 两级审批；
//   · 本轮只开客观题（单选/多选/判断/填空）；复合题/简答后续再开；
//   · 结构由 normalizeQuestion + auditQuestion 再校一遍，模型输出不能直接落库；
//   · SYSTEM_PROMPT 逐字节稳定（提示缓存）。
import { blocksToText } from "@/lib/question-model"

export const VARIANT_DIMENSIONS = [
  { value: "data", label: "换数据" },
  { value: "context", label: "换情境" },
  { value: "ask", label: "换问法" },
  { value: "combine", label: "综合知识点" },
]

export const VARIANT_QTYPES = [
  "single_choice",
  "multiple_choice",
  "true_false",
  "fill_blank",
]

const MAX_COUNT = 3

export const SYSTEM_PROMPT = `你是中职题库的变式题助手。根据一道原题，生成同题型、同知识点的变式题草稿。

只输出一个 json 对象，不要任何解释文字、不要 Markdown 代码块。对象结构：
{
  "questions": [
    {
      "qtype": "single_choice",
      "difficulty": "medium",
      "stem": "……",
      "options": [{"key": "A", "text": "……"}],
      "answer": ["A"],
      "analysis": "……",
      "variant_note": "改了什么、仍考查什么"
    }
  ],
  "caveats": "生成题请核对答案与解析"
}

规则：
- 题量与变式维度按 user 消息；最多 3 道；
- qtype 必须与原题相同；难度用 1/2/3 或 easy/medium/hard；
- 选择题必须给 4 个选项与唯一答案；判断题 answer 用 true/false；填空题用不少于 3 个下划线表示空；
- 答案必须能从题干推出；解析写清关键步骤；
- 不要照抄原题；变式维度里每一项都要体现；
- 不要编造原题没有的知识点；不要生成主观题或复合题（本轮只支持客观题）。`

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function answerOf(content) {
  const answer = content?.answer
  if (!answer) return null
  if (answer.type === "choice") return asArray(answer.keys)
  if (answer.type === "tf") return Boolean(answer.value)
  if (answer.type === "blank") return asArray(answer.values)
  if (answer.type === "text") return asArray(answer.samples)
  return null
}

/** 组 messages；dimensions 用 VARIANT_DIMENSIONS 的 value。 */
export function buildVariantMessages({
  qtype,
  difficulty,
  content,
  tags = [],
  dimensions = ["data"],
  count = 1,
  targetDifficulty = null,
} = {}) {
  const source = {
    qtype,
    difficulty,
    stem: blocksToText(content?.stem),
    options: asArray(content?.options).map((option) => ({
      key: option?.key ?? "",
      text: blocksToText(option?.label),
    })),
    answer: answerOf(content),
    analysis: blocksToText(content?.analysis),
  }
  const payload = {
    source,
    tags: asArray(tags).map((tag) => (typeof tag === "string" ? tag : tag?.name)).filter(Boolean),
    dimensions: asArray(dimensions),
    count: Math.min(MAX_COUNT, Math.max(1, Number(count) || 1)),
    target_difficulty: targetDifficulty ?? difficulty ?? null,
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请按下面的要求生成变式题，只输出 json 对象：\n${JSON.stringify(payload, null, 2)}`,
    },
  ]
}

/**
 * 校验模型返回。这里只做“形状/数量”校验；每道题的结构再由
 * normalizeQuestion + draftIssues/auditQuestion 校验，二者不能互相替代。
 */
export function validateVariantResponse(value, { maxCount = MAX_COUNT } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "返回的不是对象" }
  }
  if (!Array.isArray(value.questions)) {
    return { ok: false, reason: "questions 不是数组" }
  }
  const questions = value.questions.filter(
    (question) => question && typeof question === "object" && !Array.isArray(question)
  )
  if (questions.length === 0) {
    return { ok: false, reason: "没有生成题目" }
  }
  const warnings = []
  if (questions.length > maxCount) {
    warnings.push(`最多生成 ${maxCount} 道，已截断`)
  }
  return {
    ok: true,
    questions: questions.slice(0, maxCount),
    caveats: String(value.caveats ?? "").trim(),
    warnings,
  }
}

export function isVariantableQtype(qtype) {
  return VARIANT_QTYPES.includes(qtype)
}
