// AI 知识点标签推荐的提示词与返回校验。
//
// 硬边界：
//   · 只给建议，不写 version_tags；教师点「采纳」才进表单，保存仍走原草稿；
//   · tag_id 必须来自本次请求附带的科目子树标签；不选已选过的；
//   · 最多 5 个，按置信度降序；不确定就少选；
//   · SYSTEM_PROMPT 逐字节稳定（提示缓存）。
import { blocksToText } from "@/lib/question-model"
import { tagIndex } from "@/lib/tag-tree"

const MAX_TAGS = 5
const MAX_ALLOWED_TAGS = 300

export const SYSTEM_PROMPT = `你是中职题库的知识点标注助手。根据题目内容，从给定候选标签中选出最相关的 1–5 个知识点标签。

只输出一个 json 对象，不要任何解释文字、不要 Markdown 代码块。对象结构：
{
  "tags": [
    { "tag_id": "uuid", "confidence": 0.87, "reason": "题干考查一元二次方程的判别式" }
  ],
  "caveats": "题干较短或信息不足时的说明"
}

规则：
- tag_id 只能从 user 消息的 allowed_tags 里选；最多 5 个；按置信度降序；
- 不确定就少选；没有合适的返回空数组；
- 不要选 selected_tag_ids 里已经有的标签；
- reason 只引用题干/选项/解析里的事实，不要编造；
- confidence 是 0–1 的小数；
- 不要输出候选列表之外的标签。`

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

function compactQuestion(qtype, content) {
  return {
    qtype,
    stem: blocksToText(content?.stem),
    options: asArray(content?.options).map((option) => ({
      key: option?.key ?? "",
      text: blocksToText(option?.label),
    })),
    answer: answerOf(content),
    analysis: blocksToText(content?.analysis),
    sub_stems: asArray(content?.sub).map((sub) => ({
      type: sub?.type ?? "",
      stem: blocksToText(sub?.stem),
    })),
  }
}

/** 组 messages；tags 传当前科目子树内的标签（含 id/name/parent_id/subject_node_id）。 */
export function buildTagSuggestMessages({
  qtype,
  content,
  tags = [],
  selectedTagIds = [],
  maxTags = MAX_ALLOWED_TAGS,
} = {}) {
  const index = tagIndex(tags ?? [])
  const allowedTags = (tags ?? []).slice(0, maxTags).map((tag) => ({
    id: tag.id,
    name: tag.name,
    path: index.pathOf(tag.id),
  }))
  const payload = {
    question: compactQuestion(qtype, content),
    allowed_tags: allowedTags,
    selected_tag_ids: asArray(selectedTagIds),
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请从候选标签里给这道题打标签，只输出 json 对象：\n${JSON.stringify(payload, null, 2)}`,
    },
  ]
}

/**
 * 校验模型返回。返回 {ok:true,suggestion,warnings} 或 {ok:false,reason}。
 * 未知/已选/重复的标签会被丢弃；超过 5 个按置信度截断。
 */
export function validateTagSuggestion(
  value,
  { allowedTags = [], selectedTagIds = [], maxTags = MAX_TAGS } = {}
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "返回的不是对象" }
  }
  if (!Array.isArray(value.tags)) {
    return { ok: false, reason: "tags 不是数组" }
  }

  const tagMap = new Map(
    asArray(allowedTags).map((tag) =>
      typeof tag === "string" ? [tag, null] : [tag?.id, tag]
    )
  )
  const selected = new Set(asArray(selectedTagIds).filter(Boolean))
  const seen = new Set()
  const warnings = []
  const tags = []

  for (const raw of value.tags) {
    const tagId = String(raw?.tag_id ?? "").trim()
    if (!tagId) continue
    if (!tagMap.has(tagId)) {
      warnings.push("忽略了不在当前科目范围内的标签")
      continue
    }
    if (selected.has(tagId)) {
      warnings.push("忽略了已经选过的标签")
      continue
    }
    if (seen.has(tagId)) continue
    const reason = String(raw?.reason ?? "").trim()
    if (!reason) {
      warnings.push("忽略了没有给理由的标签")
      continue
    }
    let confidence = Number(raw?.confidence)
    if (!Number.isFinite(confidence)) confidence = 0.5
    confidence = Math.max(0, Math.min(1, confidence))
    seen.add(tagId)
    tags.push({ tag_id: tagId, confidence, reason })
  }

  tags.sort((a, b) => b.confidence - a.confidence)
  if (tags.length > maxTags) {
    warnings.push(`最多推荐 ${maxTags} 个标签，已按置信度截断`)
  }

  return {
    ok: true,
    suggestion: {
      tags: tags.slice(0, maxTags),
      caveats: String(value.caveats ?? "").trim(),
    },
    warnings: [...new Set(warnings)],
  }
}
