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

// 模型报的标记 → 库里的取值。
//
// 以前整包丢掉（flags 只由本模块自己算），于是提示词里要求它标的 cross_page 从来没进过库，
// 预览页那个「跨页」标记形同虚设——教师看不到"这道题被页边界切开了"（2026-09-24 修）。
// **必须是白名单**：模型会自创标记（"figure"、"uncertain"…），而 import_job_items.flags
// 上有 check 约束（0034/0054），混进一个未知值会让整页落库失败。
// 取值必须与那条 check 约束的清单逐字一致。
const MODEL_FLAG_MAP = {
  cross_page: "cross_page",
  cross_page_to_next: "cross_page",
  // 本页把上一页那半截并了进来——库里对应的取值叫 merged_cross_page
  cross_page_from_prev: "merged_cross_page",
  has_figure: "has_figure",
  has_formula: "has_formula",
  ai_analysis: "ai_analysis",
  ai_answer: "ai_answer",
  answer_missing: "answer_missing",
  low_confidence: "low_confidence",
}

// 并把两个题目级布尔（提示词硬性规则 7 让模型写的是布尔，不是 flags 里的字符串）
function mergeModelFlags(raw, flags) {
  for (const f of Array.isArray(raw?.flags) ? raw.flags : []) {
    const key = typeof f === "string" ? f.trim().toLowerCase() : ""
    const mapped = MODEL_FLAG_MAP[key]
    if (mapped) flags.add(mapped)
  }
  if (raw?.cross_page_to_next === true) flags.add("cross_page")
  if (raw?.cross_page_from_prev === true) flags.add("merged_cross_page")
}

// 注：这里原本有 BATCH_SIZE / MAX_TILES_PER_PAGE 两个常量，都已经被架空了，已删除。
//   · 每批页数（= 模型并发度）现在由 components/import/import-run.jsx 的 PER_CLAIM 决定 ——
//     它和「写库并发」的取舍绑在一起，必须挨着那段注释看，放在这里只会误导。
//   · 每页切片数由 import-wizard.jsx 的 buildPagePayload 按渲染模式决定（视觉路径 1×2）。

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

// 题目去重指纹（同页去重与预览页跨页查重共用）。
// **复合题必须把子题也算进去**：一篇阅读材料下面常挂着多组小问（同材料、不同小问），
// 只比材料会把后面的整组小题当成重复题丢掉——这是"小题识别不出来"的隐蔽来源之一。
export function itemFingerprint(content) {
  const subs = (Array.isArray(content?.sub) ? content.sub : [])
    .map((s) => blocksToPlain(s?.stem))
    .join("\u0001")
  return `${blocksToPlain(content?.stem).slice(0, 120)}|${JSON.stringify(content?.answer ?? {})}|${subs}`
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
  mergeModelFlags(raw, flags)
  const pageNo = ctx.pageNo ?? 0
  let qtype = normalizeQtype(raw?.qtype ?? raw?.type, ctx.defaultQtype)
  const rawSubs = subListOf(raw)
  // 模型常把复合题的 qtype 写成 short_answer（或干脆漏写），但 sub 数组在。
  // 以 sub 为准提升成复合题——否则这些小题会被整包忽略，正是"小题识别不出来"的来源之一。
  if (qtype !== "composite" && rawSubs.length > 0) qtype = "composite"
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
    let droppedSubs = 0
    collectSubQuestions(rawSubs, subs, flags, ctx, () => (droppedSubs += 1))
    if (subs.length === 0) return null
    // 有子题没识别出来时必须让教师看到：静默少几个小问比整道题丢掉更隐蔽
    if (droppedSubs > 0) flags.add("low_confidence")
    if (subs.length > 20) {
      subs.length = 20
      flags.add("low_confidence") // 截断过，必须让教师知道
    }
    content = { ...content, stem: stemBlocks, sub: subs }
  } else {
    const answer = normalizeAnswer(qtype, raw?.answer, raw, flags)
    // 答案从哪来：原卷照抄(original) / 模型自己解出来(ai) / 实在解不出(missing)。
    // 模型可能不填这个字段，那就按"有没有答案"推断——老的任务不会因为这一列而失效。
    const source = ["original", "ai", "missing"].includes(asText(raw?.answer_source))
      ? raw.answer_source
      : answer
        ? "original"
        : "missing"
    if (source === "ai" && answer) flags.add("ai_answer")
    if (!answer) {
      // 留空也照样落库：教师能在预览页补，总比整题丢掉强（入库前会被 DB 拦住，
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
    // 试卷模式下才有值；普通导入一律 null（列可空，存进去也不碍事）
    section_title: ctx.paperMode ? normalizeSectionTitle(raw?.section) : null,
    score: ctx.paperMode ? toScore(raw?.score) : null,
    score_mode: ctx.paperMode ? normalizeScoreMode(raw?.score_mode) : null,
  }
}

// 分値：只接受正数，其余（"3分"、"每题3分"、null）一律当没给。
// 在这里宽进严出没意义——算错的分数会直接印到卷面上。
function toScore(v) {
  const n = typeof v === "number" ? v : Number.parseFloat(asText(v))
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * 100) / 100 : null
}

function normalizeScoreMode(v) {
  const s = asText(v).toLowerCase()
  return ["per_item", "per_blank", "per_sub"].includes(s) ? s : null
}

// 大题标题归一。
//
// 模型对同一道大题可能给出「一、单项选择题」「1．单项选择题」「（一）单项选择题」
// 「单项选择题（共32题，每题3分，共96分）」等变体。不归一的话，一个大题会被劈成好几个，
// 卷面上就会出现三个「单项选择题」大题——这是这套解析里最容易踩、也最难排查的坑。
// 归一收口在这里（纯函数，可单测），与 normalizeQtype 的别名表同一思路：模型不可信。
const SECTION_PREFIX_RE =
  /^\s*(?:第?\s*([一二三四五六七八九十]+|\d+)\s*[、.．,，:：)）]|[（(]\s*([一二三四五六七八九十]+|\d+)\s*[）)])\s*/
// 结尾的「（共32题，每题3分，共96分）」——属于卷面排版，不属于大题名。
// 只在括号里同时含"题"或"分"时才剥，免得把「（续）」「（实验班）」这类真名字削掉。
const SECTION_TAIL_RE = /[（(][^）)]*?(?:\d+\s*[题分]|[题分]\s*\d+)[^）)]*[）)]\s*$/

export function normalizeSectionTitle(raw) {
  let t = asText(raw).replace(/\s+/g, " ").trim()
  if (!t) return null
  t = t.replace(SECTION_PREFIX_RE, "").trim()
  t = t.replace(SECTION_TAIL_RE, "").trim()
  // 剥完只剩标点/空白，说明原文本来就是个序号，保留原文比留空强
  return t || null
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

// 模型给子题数组用的键五花八门（提示词里写的是 sub，但实测它会写 subs / children…）。
// 挨个认，免得"有子题但整组被当成没有"。
const SUB_LIST_KEYS = [
  "sub",
  "subs",
  "sub_questions",
  "subQuestions",
  "subitems",
  "sub_items",
  "children",
  "questions",
]

function subListOf(raw) {
  for (const key of SUB_LIST_KEYS) {
    const v = raw?.[key]
    if (Array.isArray(v) && v.length > 0) return v
    // 只有一个小问时模型可能直接给对象（不是数组）；也可能给 {"1":…,"2":…}
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const looksLikeQuestion = v.stem || v.content || v.question || v.text || v.type || v.qtype
      if (looksLikeQuestion) return [v]
      const vals = Object.values(v).filter((x) => x && typeof x === "object")
      if (vals.length > 0) return vals
    }
  }
  return []
}

// 子题题型推断：模型经常不写 qtype（阅读材料下的小问尤其如此）。
// 丢弃会让整道复合题少几个小问，所以按选项/答案形态推断；仍看不出来就按主观题保留，
// 教师至少能在预览里看到它并对不上答案的地方有提示。
function inferSubQtype(raw, ctx, stemText = "") {
  const options = normalizeOptions(raw?.options)
  const ans = raw?.answer
  const t = asText(ans?.type).toLowerCase()
  // 答案字母数决定单选/多选：不写 qtype 的选择题，给 ["A","C"] 或 "AC" 时
  // 不能按单选处理（那会把 C 丢掉）
  const keys = Array.isArray(ans?.keys)
    ? ans.keys
    : options.length >= 2 && typeof ans === "string"
      ? ans.match(/[A-Za-z]/g) ?? []
      : []
  if (t === "choice") return keys.length > 1 ? "multiple_choice" : "single_choice"
  if (options.length >= 2) return keys.length > 1 ? "multiple_choice" : "single_choice"
  if (t === "tf") return "true_false"
  if (t === "blank") return "fill_blank"
  if (t === "text") return "short_answer"
  // 题干里有连续下划线 → 填空题（比"有没有答案"可靠）
  if (countBlanks(stemText) > 0) return "fill_blank"
  // 对/错、√/×、T/F 这类答案 → 判断题
  if (typeof ans === "boolean" || (typeof ans === "string" && toBool(ans) != null)) return "true_false"
  const d = ctx?.defaultQtype
  return d && d !== "composite" ? d : "short_answer"
}

// 收集子题，顺带把模型嵌套的 composite 平铺开（DB 与编辑器都禁止子题再嵌复合题）。
// onDrop 用来统计"确实没救回来的"子题数，调用方据此标 low_confidence。
function collectSubQuestions(list, out, parentFlags, ctx, onDrop) {
  for (const raw of list) {
    // 子题写成纯字符串：当成简答题的小问保留，总比整条丢掉强
    const item = typeof raw === "string" ? { stem: raw } : raw
    if (!item || typeof item !== "object") {
      onDrop?.()
      continue
    }
    if (normalizeQtype(item.qtype ?? item.type, null) === "composite") {
      const nested = subListOf(item)
      if (nested.length > 0) collectSubQuestions(nested, out, parentFlags, ctx, onDrop)
      else onDrop?.()
      continue
    }
    const sub = normalizeSubQuestion(item, ctx, parentFlags)
    if (sub) out.push(sub)
    else onDrop?.()
  }
}

function normalizeSubQuestion(raw, ctx, parentFlags) {
  const declared = normalizeQtype(raw?.qtype ?? raw?.type, null)
  if (declared === "composite") return null // 由 collectSubQuestions 平铺

  // 题干键也认别名：模型有时用 content/question/text 代替 stem
  const stem = stripModelMedia(
    textToBlocks(raw?.stem ?? raw?.content ?? raw?.question ?? raw?.text),
    parentFlags ?? new Set()
  )
  const stemText = blocksToPlain(stem)
  if (stemText === "") return null

  // 题型推断要读题干（空位决定填空题），所以放在题干之后
  const qtype = declared ?? inferSubQtype(raw, ctx, stemText)
  if (!qtype || qtype === "composite") return null

  // 子题也必须带 format_version：编辑器的 serializeOne 会给每个子题补上，
  // 流水线这边漏掉会让预览页的预检逐条报「缺少 format_version」（2026-10-19 修）。
  const sub = { type: qtype, format_version: 1, stem }
  if (qtype === "single_choice" || qtype === "multiple_choice") {
    sub.options = normalizeOptions(raw?.options)
  }
  // 与整题共用答案归一逻辑（answer 可能是字符串、数组、{values}、{samples}…）
  const flags = parentFlags ?? new Set()
  const answer = normalizeAnswer(qtype, raw?.answer, raw, flags)
  if (answer) sub.answer = answer
  // 子题的答案来源同样要落到整题的 flags 上：教师看的是整题徽标，
  // 不能因为"AI 推导的是小问答案"就失去紫色提示（也不能漏掉缺答案）。
  const source = asText(raw?.answer_source).toLowerCase()
  if (source === "ai" && answer) flags.add("ai_answer")
  if (!answer || source === "missing") flags.add("answer_missing")
  return sub
}

// ---------- 草稿级校验（对齐 DB，但文案面向教师） ----------

/**
 * 模拟 supabase/migrations/0003 的 v_simple_question / validate_question_content，
 * 返回中文问题清单（空数组 = 这道题能过 DB 校验）。
 * 注意：**DB 才是权威**，这里只求"入库前就能看见问题"，允许比 DB 更严、不允许更松。
 * nested=true 表示正在校验复合题的某个子题：DB 对子题只走 v_simple_question，
 * 不检查 format_version，这里也必须同样放行。
 */
export function draftIssues(qtype, content, { nested = false } = {}) {
  const issues = []
  if (!content || typeof content !== "object") return ["内容为空"]
  // 只在整题顶层检查 format_version：DB 的 validate_question_content 也只查顶层，
  // 子题走 v_simple_question（不看这个字段）。早先这里递归检查，导致 AI 导入的每道
  // 复合题都报「子题 N：缺少 format_version」，把整道题挡在入库之外（2026-10-19 修）。
  if (!nested && content.format_version == null) issues.push("缺少 format_version")

  if (qtype === "composite") {
    const subs = Array.isArray(content.sub) ? content.sub : []
    if (subs.length === 0) issues.push("复合题至少要有一道子题")
    if (subs.length > 20) issues.push("复合题子题最多 20 道")
    subs.forEach((s, i) => {
      if (!s?.type) issues.push(`第 ${i + 1} 道子题缺少题型`)
      else if (s.type === "composite") issues.push(`第 ${i + 1} 道子题不能再是复合题`)
      else for (const m of draftIssues(s.type, s, { nested: true })) issues.push(`子题 ${i + 1}：${m}`)
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
    const key = itemFingerprint(it.content)
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
    // 试卷模式才有；普通导入返回 null/[]，写入端按"没有就跳过"处理
    paper: ctx.paperMode ? normalizePaperMeta(wire?.paper) : null,
    sections: ctx.paperMode ? normalizeSections(wire?.sections, deduped) : [],
  }
}

// 卷头元信息。数值一律"没有就省略"——编出来的考试时长/总分会被直接印在卷面上。
function normalizePaperMeta(raw) {
  if (!raw || typeof raw !== "object") return null
  const out = {}
  const examName = asText(raw.exam_name).trim()
  const subjectLabel = asText(raw.subject_label).trim()
  const title = asText(raw.title).trim()
  if (examName) out.exam_name = examName.slice(0, 120)
  if (subjectLabel) out.subject_label = subjectLabel.slice(0, 60)
  if (title) out.title = title.slice(0, 120)
  const minutes = toPositiveInt(raw.duration_minutes, 1, 600)
  const score = toScore(raw.total_score)
  if (minutes) out.duration_minutes = minutes
  if (score) out.total_score = score
  return Object.keys(out).length > 0 ? out : null
}

// 大题清单：以模型给的 sections 为准，但把题目里出现、而 sections 漏掉的补上——
// 跨页时模型很容易只给题不给 sections，漏掉的话那批题会归到"未分大题"里。
function normalizeSections(raw, items) {
  const out = []
  const seen = new Set()
  const push = (title, instruction) => {
    const t = normalizeSectionTitle(title)
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push({ title: t, instruction: asText(instruction).trim().slice(0, 200) || null })
  }
  for (const s of Array.isArray(raw) ? raw : []) push(s?.title, s?.instruction)
  for (const it of items) push(it.section_title, null)
  return out
}

function toPositiveInt(v, min, max) {
  const n = typeof v === "number" ? v : Number.parseInt(asText(v), 10)
  return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : null
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
