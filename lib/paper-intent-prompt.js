// 一句话组卷：把教师的自然语言转成可执行的组卷约束。
//
// 硬边界（与 lib/grading-prompt.js 同一套思路）：
//   · 模型只把原话转成 spec，**不选题、不写库**；选题仍由本地 optimizePaperPlan 完成；
//   · 题型/科目/标签必须来自本次请求附带的允许集合，模型不能发明；
//   · 信息不足时返回 clarify，不猜；
//   · SYSTEM_PROMPT 逐字节稳定（上游按前缀命中提示缓存）。
//
// 与现有 planner 的衔接：本模块输出 easy/medium/hard 的人话配比，
// intentToRows() 再映射成编辑器表单的 {1,2,3} 百分比；不要把模型输出直接塞给优化器。
import { QTYPES, qtypeLabel } from "@/lib/question-model"
import { nodePathOf } from "@/lib/subject-nodes"
import { tagIndex } from "@/lib/tag-tree"

const MAX_SECTIONS = 8
const MAX_COUNT = 50
const MAX_TAGS = 8
const MIN_SCORE_EACH = 0.5
const MAX_SCORE_EACH = 20

export const SYSTEM_PROMPT = `你是中职组卷助手。把教师的一句话组卷要求转成结构化约束。你不选题，只把要求写清楚。

只输出一个 json 对象，不要任何解释文字、不要 Markdown 代码块。对象结构：
{
  "target_score": 90,
  "exclude_recent_days": 30,
  "node_id": "uuid|null",
  "requested_tag_ids": ["uuid"],
  "sections": [
    {
      "title": "单项选择题",
      "qtype": "single_choice",
      "count": 10,
      "score_mode": "per_item",
      "score_each": 3,
      "difficulty_mix": { "easy": 0.6, "medium": 0.3, "hard": 0.1 },
      "max_per_tag": 3
    }
  ],
  "assumptions": ["需要教师确认的推断"],
  "clarify": "信息不足时在这里问一句；否则为 null"
}

规则：
- qtype 只能从 user 消息的 allowed_qtypes 里选；score_mode 只能 per_item / per_blank / per_sub；
- sections 1–8 个；count 1–50；score_each 0.5–20；
- difficulty_mix 的 easy / medium / hard 三个份额都在 0–1，合计约等于 1；
- node_id 只能取 allowed_nodes 里的 id 或 null；requested_tag_ids 只能从 allowed_tags 里选，最多 8 个；
- 教师没有明确说的字段用合理默认：难度 0.3 / 0.5 / 0.2，排除最近 90 天，目标分为 null；
- 如果教师给了目标分或难度配比、但没写大题结构，**按常见结构给默认方案**（例如单选 10 题、填空 5 题、其余主观题；分值按目标分拆），并在 assumptions 里写明“默认大题结构，可修改”；不要因为没写大题结构就返回 clarify；
- 只有连科目/目标分这类范围信息都缺失、无法判断时，才把要问的话放进 clarify，sections 可以为空；
- 如果原话不是组卷请求（例如只是在评论考试难度、表达情绪、闲聊），不要生成 sections，把想问的问题放进 clarify；
- assumptions 只写你从原话推断出的、需要教师确认的假设，最多 5 条；
- 教师原话优先：不要改教师说的分值、题数、难度；不要编造不存在的题型、标签、科目。`

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function textOf(value) {
  return String(value ?? "").trim()
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function cleanClarify(value) {
  const s = textOf(value)
  if (!s) return ""
  if (["null", "none", "无", "-", "没有"].includes(s.toLowerCase())) return ""
  return s
}

function pick(value, ...keys) {
  for (const key of keys) {
    if (value && value[key] !== undefined && value[key] !== null) return value[key]
  }
  return undefined
}

function normalizeQtype(raw, allowed) {
  const s = textOf(raw)
  if (allowed.includes(s)) return s
  const byLabel = QTYPES.find((q) => q.label === s || q.short === s)
  if (byLabel && allowed.includes(byLabel.value)) return byLabel.value
  return null
}

/**
 * 组 messages。system 稳定、动态上下文全部放 user，命中提示缓存。
 * tags 传当前科目子树内的标签（id/name/parent_id/subject_node_id 即可）。
 */
export function buildPaperIntentMessages({
  text,
  node = null,
  nodes = [],
  tags = [],
  qtypes = QTYPES,
  currentTarget = null,
  currentSections = [],
  maxTags = 300,
} = {}) {
  const index = tagIndex(tags ?? [])
  const tagList = (tags ?? []).slice(0, maxTags).map((tag) => ({
    id: tag.id,
    name: tag.name,
    path: index.pathOf(tag.id),
  }))
  const nodePath = node ? nodePathOf(nodes, node.id) : ""
  const payload = {
    request: textOf(text),
    current_node: node ? { id: node.id, name: node.name, path: nodePath } : null,
    allowed_nodes: node ? [{ id: node.id, name: node.name, path: nodePath }] : [],
    allowed_tags: tagList,
    allowed_qtypes: (qtypes ?? QTYPES).map((q) => ({ value: q.value, label: q.label })),
    current_paper: {
      target_score: currentTarget ?? null,
      sections: asArray(currentSections).slice(0, MAX_SECTIONS).map((section) => ({
        title: textOf(section.title),
        qtype: textOf(section.qtype),
        count: Number(section.count) || 0,
      })),
    },
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请把下面这句话转成组卷约束，只输出 json 对象：\n${JSON.stringify(payload, null, 2)}`,
    },
  ]
}

/**
 * 校验模型返回。返回 {ok:true,intent,warnings} 或 {ok:false,reason}。
 * allowedTags 可传 id 数组或标签对象数组；allowedNodeIds 只放当前卷面科目。
 */
export function validatePaperIntent(
  value,
  {
    allowedNodeIds = [],
    allowedTags = [],
    allowedQtypes = QTYPES.map((q) => q.value),
    maxSections = MAX_SECTIONS,
  } = {}
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "返回的不是对象" }
  }

  const warnings = []
  const tagMap = new Map(
    asArray(allowedTags).map((tag) =>
      typeof tag === "string" ? [tag, null] : [tag?.id, tag]
    )
  )
  const allowedNodes = new Set(asArray(allowedNodeIds).filter(Boolean))
  const clarify = cleanClarify(value.clarify)
  const rawSections = asArray(value.sections)

  if (clarify && rawSections.length === 0) {
    return {
      ok: true,
      intent: {
        node_id: null,
        target_score: null,
        exclude_recent_days: 90,
        requested_tag_ids: [],
        sections: [],
        assumptions: asArray(value.assumptions).map(textOf).filter(Boolean).slice(0, 5),
        clarify,
      },
      warnings,
    }
  }
  if (rawSections.length === 0) {
    return { ok: false, reason: "没有解析出大题结构" }
  }
  if (rawSections.length > maxSections) {
    return { ok: false, reason: `最多 ${maxSections} 个大题` }
  }

  const sections = []
  for (let i = 0; i < rawSections.length; i++) {
    const raw = rawSections[i] ?? {}
    const qtype = normalizeQtype(raw.qtype, allowedQtypes)
    if (!qtype) {
      return { ok: false, reason: `第 ${i + 1} 个大题的题型不在允许列表里` }
    }
    const count = Math.round(Number(raw.count))
    if (!Number.isFinite(count) || count < 1 || count > MAX_COUNT) {
      return { ok: false, reason: `第 ${i + 1} 个大题的题数应在 1–${MAX_COUNT}` }
    }
    const scoreModeRaw = textOf(raw.score_mode)
    const scoreMode = ["per_item", "per_blank", "per_sub"].includes(scoreModeRaw)
      ? scoreModeRaw
      : "per_item"
    const scoreEach = Number(raw.score_each)
    if (
      !Number.isFinite(scoreEach) ||
      scoreEach < MIN_SCORE_EACH ||
      scoreEach > MAX_SCORE_EACH
    ) {
      return {
        ok: false,
        reason: `第 ${i + 1} 个大题的分值应在 ${MIN_SCORE_EACH}–${MAX_SCORE_EACH}`,
      }
    }

    const rawMix = raw.difficulty_mix ?? {}
    const mix = [
      Number(pick(rawMix, "easy", "1", 1) ?? 0),
      Number(pick(rawMix, "medium", "2", 2) ?? 0),
      Number(pick(rawMix, "hard", "3", 3) ?? 0),
    ].map((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0))
    if (mix.every((v) => v === 0)) {
      mix[0] = 0.3
      mix[1] = 0.5
      mix[2] = 0.2
    }
    const mixTotal = mix[0] + mix[1] + mix[2]
    if (mixTotal < 0.95 || mixTotal > 1.05) {
      return { ok: false, reason: `第 ${i + 1} 个大题的难度配比合计应约等于 1` }
    }

    const maxPerTag = numberOrNull(raw.max_per_tag)
    sections.push({
      title: textOf(raw.title) || qtypeLabel(qtype),
      qtype,
      count,
      score_mode: scoreMode,
      score_each: Math.round(scoreEach * 100) / 100,
      difficulty_mix: { easy: mix[0], medium: mix[1], hard: mix[2] },
      max_per_tag:
        maxPerTag != null && maxPerTag > 0
          ? Math.min(50, Math.round(maxPerTag))
          : null,
    })
  }

  const rawTarget = numberOrNull(value.target_score)
  let targetScore = null
  if (rawTarget != null) {
    if (rawTarget < 10 || rawTarget > 300) {
      warnings.push("目标分不在 10–300，已忽略")
    } else {
      targetScore = Math.round(rawTarget * 2) / 2
      if (targetScore < 30 || targetScore > 150) {
        warnings.push("目标分不在常见 30–150 区间，请确认")
      }
    }
  }

  const rawExclude = numberOrNull(value.exclude_recent_days)
  const excludeRecent =
    rawExclude == null ? 90 : Math.min(3650, Math.max(0, Math.round(rawExclude)))

  let nodeId = null
  const rawNode = textOf(value.node_id)
  if (rawNode && allowedNodes.has(rawNode)) {
    nodeId = rawNode
  } else if (rawNode) {
    warnings.push("模型给的科目节点不在当前卷面范围内，已按当前科目处理")
  }

  const requestedTagIds = []
  for (const raw of asArray(value.requested_tag_ids)) {
    const id = textOf(raw)
    if (!id) continue
    if (!tagMap.has(id)) {
      warnings.push("忽略了不在当前科目范围内的标签")
      continue
    }
    if (!requestedTagIds.includes(id)) requestedTagIds.push(id)
    if (requestedTagIds.length >= MAX_TAGS) break
  }

  return {
    ok: true,
    intent: {
      node_id: nodeId,
      target_score: targetScore,
      exclude_recent_days: excludeRecent,
      requested_tag_ids: requestedTagIds,
      sections,
      assumptions: asArray(value.assumptions).map(textOf).filter(Boolean).slice(0, 5),
      clarify: "",
    },
    warnings: [...new Set(warnings)],
  }
}

function mixToPercent(mix = {}) {
  const raw = [
    Math.max(0, Number(mix.easy) || 0),
    Math.max(0, Number(mix.medium) || 0),
    Math.max(0, Number(mix.hard) || 0),
  ]
  const total = raw[0] + raw[1] + raw[2]
  const base = total > 0 ? raw.map((v) => Math.round((v / total) * 100)) : [30, 50, 20]
  const diff = 100 - base.reduce((sum, value) => sum + value, 0)
  if (diff !== 0) {
    const index = base.indexOf(Math.max(...base))
    base[index] += diff
  }
  return { 1: base[0], 2: base[1], 3: base[2] }
}

/** 意图 → 编辑器表单行（mix 用 0–100 百分比；优化器在 buildSpec 里再除 100）。 */
export function intentToRows(intent) {
  return asArray(intent?.sections).map((section, index) => ({
    key: `intent_${index}`,
    title: section.title || qtypeLabel(section.qtype),
    qtype: section.qtype,
    count: section.count,
    score_mode: section.score_mode,
    score_each: section.score_each,
    mix: mixToPercent(section.difficulty_mix),
    ...(section.max_per_tag ? { max_per_tag: section.max_per_tag } : {}),
  }))
}
