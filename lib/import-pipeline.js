// 批量导入的纯函数层：把大模型吐出的「wire format」规范化成严格的 content 契约，
// 并做草稿级预检。前后端共用（服务端在路由里调，客户端在预览页做即时校验）。
//
// 为什么要有一层独立的 wire format 而不是让模型直接输出 content：
//   · content 里的块数组（[{t:"text",text}]）对模型是纯负担，既费输出 token 又容易写错；
//     让模型输出纯字符串、由这里套上结构，实测错误率低得多；
//   · 模型不可信：编号、大小写、题型别名、答案形态必须在这里收口，DB 的
//     validate_question_content 是最后一道闸，但它报的是「题干不能为空」这类，
//     对教师不友好；这里多一道预检，预览页能直接标出「这道题为什么入不了库」。
//
// 本模块**不引入任何依赖**（服务端与浏览器都要能 import），也不碰数据库。

import { countBlanks, optionLetter } from "@/lib/question-model"

// ---------- 常量 ----------

export const WIRE_QTYPES = [
  "single_choice",
  "multiple_choice",
  "true_false",
  "fill_blank",
  "short_answer",
  "composite",
]

// 题型的常见别名（模型经常按中文卷面写，或写成 single/choice 之类的简写）
const QTYPE_ALIASES = {
  单选: "single_choice",
  单选题: "single_choice",
  选择题: "single_choice",
  single: "single_choice",
  singlechoice: "single_choice",
  choice: "single_choice",
  多选: "multiple_choice",
  多选题: "multiple_choice",
  multi: "multiple_choice",
  multiple: "multiple_choice",
  multiplechoice: "multiple_choice",
  判断: "true_false",
  判断题: "true_false",
  truefalse: "true_false",
  tf: "true_false",
  填空: "fill_blank",
  填空题: "fill_blank",
  fillblank: "fill_blank",
  blank: "fill_blank",
  简答: "short_answer",
  简答题: "short_answer",
  主观题: "short_answer",
  解答题: "short_answer",
  论述题: "short_answer",
  问答: "short_answer",
  shortanswer: "short_answer",
  text: "short_answer",
  复合题: "composite",
  材料题: "composite",
  综合题: "composite",
  composite: "composite",
}

const DIFFICULTY_ALIASES = { 易: 1, 简单: 1, 容易: 1, 中: 2, 中等: 2, 一般: 2, 难: 3, 困难: 3 }

// 每批页数：文字路径一次可以多给几页（token 便宜、跨页连贯），视觉路径必须小
// （单请求出错时爆炸半径小，且请求体必须远离 Next proxy 的提交体上限）
export const BATCH_SIZE = { text: 5, vision: 2 }
export const MAX_TILES_PER_PAGE = 8 // 2 列 × 3 行 = 6，留一点余量

// ---------- 小工具 ----------

const asText = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim())

// 纯文本 → 文本块数组：空行分段（保留原文的段落结构），单块内部不再切
export function textToBlocks(text) {
  const t = asText(text)
  if (!t) return []
  return t
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ t: "text", text: p }))
}

export function blocksToPlain(blocks) {
  if (!Array.isArray(blocks)) return ""
  return blocks
    .filter((b) => b?.t === "text")
    .map((b) => b.text ?? "")
    .join("\n")
}

// 模型可能自己"发明"媒体块（它给不出合法的 OSS key，DB 的 v_blocks_text 要求 key 非空）
// ——一律剥掉，换成可读占位，交给教师后续插图
const FIGURE_RE = /\[\[图(\d*)\]\]/g

function stripModelMedia(blocks, flags) {
  const out = []
  for (const b of blocks) {
    if (b?.t === "media") {
      flags.add("has_figure")
      continue
    }
    if (b?.t !== "text") continue
    let text = b.text ?? ""
    if (FIGURE_RE.test(text)) {
      flags.add("has_figure")
      // 统一成 [[图1]] 这类稳定占位（模型的编号可能跳号，重排一次）
      let n = 0
      text = text.replace(FIGURE_RE, () => `[[图${++n}]]`)
    }
    out.push({ t: "text", text })
  }
  return out
}

function normalizeQtype(raw, fallback) {
  const key = asText(raw).toLowerCase().replace(/[\s_-]/g, "")
  if (WIRE_QTYPES.includes(raw)) return raw
  return QTYPE_ALIASES[key] ?? QTYPE_ALIASES[asText(raw)] ?? fallback ?? null
}

function normalizeDifficulty(raw, fallback) {
  if (typeof raw === "number" && raw >= 1 && raw <= 3) return Math.round(raw)
  const s = asText(raw)
  if (DIFFICULTY_ALIASES[s]) return DIFFICULTY_ALIASES[s]
  const n = Number.parseInt(s, 10)
  if (n >= 1 && n <= 3) return n
  return fallback ?? 2
}

// 判断题答案：模型可能写对/错/√/×/T/F/true/正确
function toBool(raw) {
  if (typeof raw === "boolean") return raw
  const s = asText(raw).toLowerCase()
  if (["对", "正确", "√", "✓", "t", "true", "yes", "是", "1"].includes(s)) return true
  if (["错", "错误", "×", "✗", "x", "f", "false", "no", "否", "0"].includes(s)) return false
  return null
}

// 选项 key 归一：模型可能给 1/2/3、a/b/c、也可能是完整文本
function normalizeOptionKeys(raw, options, single) {
  if (raw == null) return null
  const keys = Array.isArray(raw) ? raw : asText(raw).match(/[A-Za-z0-9]/g) ?? []
  const valid = new Set(options.map((o) => o.key))
  const out = []
  for (const k of keys) {
    const s = asText(k)
    let letter = s.toUpperCase()
    // 模型给数字序号时按 1 基转字母（卷面常见「1. 2. 3.」的选项编号）
    if (/^\d+$/.test(s)) {
      const n = Number.parseInt(s, 10)
      if (n >= 1 && n <= options.length) letter = optionLetter(n - 1)
    }
    if (valid.has(letter) && !out.includes(letter)) out.push(letter)
  }
  if (out.length === 0) return null
  return single ? [out[0]] : out
}

// ---------- 单题规范化 ----------

/**
 * 把模型输出的一道题规范化成 { qtype, difficulty, content, flags, confidence, source_quote }
 * 返回 null 表示这道题根本无法使用（连题干都没有），调用方应丢弃并在 notes 里体现。
 */
export function normalizeQuestion(raw, ctx = {}) {
  const flags = new Set()
  const pageNo = ctx.pageNo ?? 0
  const qtype = normalizeQtype(raw?.qtype ?? raw?.type, ctx.defaultQtype)
  if (!qtype) return null

  const stemBlocks = stripModelMedia(textToBlocks(raw?.stem ?? raw?.content ?? ""), flags)
  const stemText = blocksToPlain(stemBlocks)
  if (qtype !== "composite" && !stemText) return null

  const difficulty = normalizeDifficulty(raw?.difficulty ?? raw?.level, ctx.defaultDifficulty)

  let content = { format_version: 1 }
  const analysisBlocks = stripModelMedia(
    textToBlocks(raw?.analysis ?? raw?.explain ?? raw?.solution ?? ""),
    flags
  )
  if (analysisBlocks.length > 0) {
    content.analysis = analysisBlocks
    if (ctx.genAnalysis) flags.add("ai_analysis")
  } else if (ctx.genAnalysis) {
    flags.add("no_analysis")
  }

  if (qtype === "composite") {
    const subs = []
    for (const s of Array.isArray(raw?.sub) ? raw.sub : []) {
      const sub = normalizeSubQuestion(s, ctx)
      if (sub) subs.push(sub)
    }
    if (subs.length === 0) return null
    if (subs.length > 20) {
      subs.length = 20
      flags.add("low_confidence") // 截断过，必须让教师知道
    }
    content = { ...content, stem: stemBlocks, sub: subs }
  } else {
    const answer = normalizeAnswer(qtype, raw?.answer, raw, flags)
    if (!answer) {
      // 抽不到答案也照样落库：教师能在预览页补，总比整题丢掉强（入库前会被 DB 拦住，
      // 所以预览默认不勾选它——见 0034 的 answer_missing 标记）
      flags.add("answer_missing")
    }
    const options = normalizeOptions(raw?.options)
    content = { ...content, stem: stemBlocks }
    if (options.length > 0) content.options = options
    if (answer) content.answer = answer
  }

  // 与 DB 的硬校验逐条对齐（题干/答案/空位/选项数），差异在这里先暴露
  const issues = draftIssues(qtype, content)
  if (issues.length > 0) flags.add("low_confidence")

  const confidence = typeof raw?.confidence === "number" ? raw.confidence : null
  if (confidence != null && confidence < 0.6) flags.add("low_confidence")
  if (asText(raw?.readability).toLowerCase() === "poor") flags.add("low_confidence")

  return {
    qno: asText(raw?.qno ?? raw?.number ?? raw?.no) || null,
    qtype,
    difficulty,
    content,
    flags: [...flags],
    confidence,
    source_quote: asText(raw?.source_quote).slice(0, 200) || null,
    page_no: pageNo,
    issues,
  }
}

// 选项写成字符串时，模型常把卷面的字母前缀一起带上（"A. 甲"、"（C）丙"）。留着它界面会
// 显示成「A. A. 甲」——字母由 UI 单独画，所以这里剥掉前缀并把字母当成 key。
// 两种形态：括号包裹（（C）丙）或字母 + 分隔符（A. 甲 / B、乙 / C) 丙）。
// **必须要求分隔符**：否则 "RAM 断电后…" 会被剥成 key=R、"x 轴表示时间" 会被剥成 key=X。
const OPTION_PREFIX_RE = /^\s*(?:[（(]\s*([A-Za-z])\s*[）)]|([A-Za-z])\s*[.、:：．)）])\s*/

function normalizeOptions(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const o of list) {
    if (out.length >= 26) break
    let text = asText(typeof o === "string" ? o : (o?.text ?? blocksToPlain(o?.label)))
    let key = asText(o?.key).toUpperCase()
    if (!/^[A-Z]$/.test(key)) {
      const m = text.match(OPTION_PREFIX_RE)
      const rest = m ? text.slice(m[0].length).trim() : ""
      if (m && rest) {
        key = (m[1] ?? m[2]).toUpperCase()
        text = rest
      }
    }
    if (!/^[A-Z]$/.test(key)) key = optionLetter(out.length)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, label: textToBlocks(text) })
  }
  return out
}

function normalizeAnswer(qtype, raw, whole, flags) {
  if (qtype === "single_choice" || qtype === "multiple_choice") {
    const options = normalizeOptions(whole?.options)
    if (options.length < 2) return null
    const keys = normalizeOptionKeys(
      raw?.keys ?? raw?.key ?? raw?.value ?? raw,
      options,
      qtype === "single_choice"
    )
    return keys ? { type: "choice", keys } : null
  }
  if (qtype === "true_false") {
    const v = toBool(raw?.value ?? raw?.answer ?? raw)
    return v == null ? null : { type: "tf", value: v }
  }
  if (qtype === "fill_blank") {
    const arr = Array.isArray(raw?.values) ? raw.values : Array.isArray(raw) ? raw : [raw?.value ?? raw]
    const values = arr.map((x) => asText(x)).filter((x) => x !== "")
    return values.length > 0 ? { type: "blank", values } : null
  }
  if (qtype === "short_answer") {
    // 参考答案可能是多行字符串，也可能已经是数组
    const arr = Array.isArray(raw?.samples)
      ? raw.samples
      : Array.isArray(raw)
        ? raw
        : asText(raw?.value ?? raw?.samples ?? raw ?? "").split(/\n+/)
    const samples = arr.map((x) => asText(x)).filter(Boolean)
    return samples.length > 0 ? { type: "text", samples } : null
  }
  return null
}

function normalizeSubQuestion(raw, ctx) {
  const qtype = normalizeQtype(raw?.qtype ?? raw?.type, null)
  // 子题不允许嵌套复合题（前端与 DB 都拦），直接降级丢弃
  if (!qtype || qtype === "composite") return null
  const flags = new Set()
  const stem = stripModelMedia(textToBlocks(raw?.stem), flags)
  if (blocksToPlain(stem) === "") return null
  const sub = { type: qtype, stem }
  if (qtype === "single_choice" || qtype === "multiple_choice") {
    const options = normalizeOptions(raw?.options)
    const keys = normalizeOptionKeys(
      raw?.answer?.keys ?? raw?.answer?.key ?? raw?.answer,
      options,
      qtype === "single_choice"
    )
    sub.options = options
    if (keys) sub.answer = { type: "choice", keys }
  } else if (qtype === "true_false") {
    const v = toBool(raw?.answer?.value ?? raw?.answer)
    if (v != null) sub.answer = { type: "tf", value: v }
  } else if (qtype === "fill_blank") {
    const arr = Array.isArray(raw?.answer?.values) ? raw.answer.values : []
    const values = arr.map((x) => asText(x)).filter(Boolean)
    if (values.length) sub.answer = { type: "blank", values }
  } else if (qtype === "short_answer") {
    const arr = Array.isArray(raw?.answer?.samples)
      ? raw.answer.samples
      : asText(raw?.answer?.value ?? raw?.answer ?? "").split(/\n+/)
    const samples = arr.map((x) => asText(x)).filter(Boolean)
    if (samples.length) sub.answer = { type: "text", samples }
  }
  return sub
}

// ---------- 草稿级校验（对齐 DB，但文案面向教师） ----------

/**
 * 模拟 supabase/migrations/0003 的 v_simple_question / validate_question_content，
 * 返回中文问题清单（空数组 = 这道题能过 DB 校验）。
 * 注意：**DB 才是权威**，这里只求"入库前就能看见问题"，允许比 DB 更严、不允许更松。
 */
export function draftIssues(qtype, content) {
  const issues = []
  if (!content || typeof content !== "object") return ["内容为空"]
  if (content.format_version == null) issues.push("缺少 format_version")

  if (qtype === "composite") {
    const subs = Array.isArray(content.sub) ? content.sub : []
    if (subs.length === 0) issues.push("复合题至少要有一道子题")
    if (subs.length > 20) issues.push("复合题子题最多 20 道")
    subs.forEach((s, i) => {
      if (!s?.type) issues.push(`第 ${i + 1} 道子题缺少题型`)
      else if (s.type === "composite") issues.push(`第 ${i + 1} 道子题不能再是复合题`)
      else for (const m of draftIssues(s.type, s)) issues.push(`子题 ${i + 1}：${m}`)
    })
    return issues
  }

  const stem = blocksToPlain(content.stem)
  if (stem.trim() === "") issues.push("题干不能为空")

  if (qtype === "single_choice" || qtype === "multiple_choice") {
    const options = Array.isArray(content.options) ? content.options : []
    if (options.length < 2) issues.push("选择题至少要 2 个选项")
    if (options.length > 26) issues.push("选择题最多 26 个选项")
    if (new Set(options.map((o) => asText(o?.key).toUpperCase())).size !== options.length)
      issues.push("选项 key 重复")
    const keys = content.answer?.keys
    if (!Array.isArray(keys) || keys.length === 0) issues.push("选择题必须有正确答案")
    else {
      const valid = new Set(options.map((o) => asText(o?.key).toUpperCase()))
      for (const k of keys) if (!valid.has(asText(k).toUpperCase())) issues.push(`答案 ${k} 不在选项中`)
      if (qtype === "single_choice" && keys.length !== 1) issues.push("单选题只能有一个正确答案")
    }
  } else if (qtype === "true_false") {
    if (typeof content.answer?.value !== "boolean") issues.push("判断题缺少正确答案")
  } else if (qtype === "fill_blank") {
    const values = content.answer?.values
    if (!Array.isArray(values) || values.length === 0) issues.push("填空题必须有答案")
    else {
      const blanks = countBlanks(stem)
      if (blanks !== values.length) issues.push(`题干有 ${blanks} 个空位，但有 ${values.length} 个答案`)
    }
  } else if (qtype === "short_answer") {
    const samples = content.answer?.samples
    if (!Array.isArray(samples) || samples.length === 0) issues.push("主观题必须有参考答案")
  } else {
    issues.push(`未知题型 ${qtype}`)
  }
  return issues
}

// ---------- 整页规范化 ----------

/**
 * 规范化一页的结果。
 * @returns { items, notes, readability, stats } —— items 已按 seq 顺序排好
 */
export function normalizePage(wire, ctx = {}) {
  const flagsAtPage = []
  const rawQuestions = Array.isArray(wire?.questions) ? wire.questions : []
  const items = []
  let dropped = 0

  rawQuestions.forEach((raw, i) => {
    const item = normalizeQuestion(raw, ctx)
    if (!item) {
      dropped += 1
      return
    }
    item.seq = i
    items.push(item)
  })

  // 同一页内的重复题（模型偶尔会把同一道题吐两遍）：保留先出现的，标 dup_in_job
  const seen = new Map()
  const deduped = []
  for (const it of items) {
    const key = `${blocksToPlain(it.content.stem).slice(0, 120)}|${JSON.stringify(it.content.answer ?? {})}`
    if (seen.has(key)) {
      seen.get(key).flags.push("dup_in_job")
      continue
    }
    seen.set(key, it)
    deduped.push(it)
  }

  return {
    items: deduped,
    notes: asText(wire?.notes).slice(0, 500),
    readability: asText(wire?.readability).toLowerCase() || "ok",
    stats: { parsed: rawQuestions.length, kept: deduped.length, dropped },
    pageFlags: flagsAtPage,
  }
}

// ---------- 用量与费用 ----------

// 谷时/峰时的价格都在变，这里只给一个量级估算，用于预览页展示"这次花了多少"
const PRICE = { inputMiss: 0.3, inputHit: 0.006, output: 1.2, currency: "USD" }

export function costOf(usageList) {
  const sum = { prompt: 0, completion: 0, hit: 0, miss: 0 }
  for (const u of usageList ?? []) {
    if (!u || typeof u !== "object") continue
    const prompt = Number(u.prompt_tokens ?? 0)
    const hit = Number(u.prompt_cache_hit_tokens ?? 0)
    sum.prompt += prompt
    sum.hit += hit
    sum.miss += Math.max(0, prompt - hit)
    sum.completion += Number(u.completion_tokens ?? 0)
  }
  const usd =
    (sum.miss * PRICE.inputMiss + sum.hit * PRICE.inputHit + sum.completion * PRICE.output) / 1_000_000
  return { ...sum, usd: Math.round(usd * 10000) / 10000, currency: PRICE.currency }
}
