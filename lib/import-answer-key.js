// 答案区（0146）：答案键的规范化、合并与「两份答案是否冲突」的判定。
//
// 与 lib/import-pipeline.js 分开放，是因为这里的每一条都是**纯函数**、可直接单测，
// 而 pipeline 那 650 行已经背着"模型输出不可信"的全部容错，不该再往里堆。
//
// 两个口径先说清楚：
//   · 答案键里的答案**一律是文本**（"A"、"AB"、"①③"）。答案区那一步不猜题型——
//     猜错了后面全错，题型转换交给手上有题干与选项的题目页模型。
//   · 只有**客观题**才判「冲突」。简答题两份措辞几乎永远不同，见一条标一条，
//     教师很快就会把这个标记当成噪音（AGENTS.md「查重」一节的教训）。

const asText = (v) => (typeof v === "string" ? v.trim() : "")

/** 题号归一：全角数字/句点/括号统一，去掉所有空白。只用于比对，展示时仍用原文。 */
export function normalizeQno(v) {
  return asText(v)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, ".")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s+/g, "")
}

/** 大题标题归一：同上，去掉空白与句点差异。 */
export function normalizeSectionKey(v) {
  return asText(v).replace(/\s+/g, "").replace(/[．。]/g, ".")
}

const entryKey = (e) => `${normalizeSectionKey(e?.section)}\u0001${normalizeQno(e?.qno)}`

/**
 * 把模型吐的答案区结果规范化成答案键条目。
 *
 * 接受三种形状（模型实测都会出现）：
 *   · `{answers:[{section,qno,answer_text,analysis}]}`（提示词要求的）
 *   · `{answers:{"12":"A","13":"BC"}}`（直接把题号当键）
 *   · `{answers:{"12":{answer_text:"A",analysis:"…"}}}`
 *
 * @returns { entries, dropped, truncated }  dropped = 没有题号或没有答案、被丢掉的条数
 */
export function normalizeAnswerKey(wire, { maxEntries = 500, maxText = 2000, maxAnalysis = 600 } = {}) {
  const raw = wire?.answers
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === "object") {
    list = Object.entries(raw).map(([qno, v]) =>
      typeof v === "string"
        ? { qno, answer_text: v }
        : { qno, ...(v && typeof v === "object" ? v : {}) }
    )
  }

  const entries = []
  const seen = new Set()
  let dropped = 0
  let truncated = false

  for (const e of list) {
    if (entries.length >= maxEntries) {
      truncated = true
      break
    }
    const qno = normalizeQno(e?.qno)
    const answerText = asText(e?.answer_text ?? e?.answer ?? e?.text).slice(0, maxText)
    if (!qno || !answerText) {
      dropped += 1
      continue
    }
    const section = asText(e?.section).slice(0, 120)
    const analysis = asText(e?.analysis).slice(0, maxAnalysis)
    const item = {
      section: section || null,
      qno: asText(e?.qno).slice(0, 40) || qno,
      answer_text: answerText,
      analysis: analysis || null,
    }
    // 同一 (大题, 题号) 只留先出现的：跨页重复与模型自己吐两遍是常态
    const key = entryKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(item)
  }

  return { entries, dropped, truncated: truncated || Boolean(wire?._salvaged) }
}

/** 把新一页的条目并进已有的键：同 (大题,题号) 保留先出现的（先解析的页更靠前）。 */
export function mergeAnswerEntries(existing, incoming, maxEntries = 500) {
  const out = []
  const seen = new Set()
  for (const e of [...(existing ?? []), ...(incoming ?? [])]) {
    const key = entryKey(e)
    if (!normalizeQno(e?.qno) || seen.has(key)) continue
    seen.add(key)
    out.push(e)
    if (out.length >= maxEntries) break
  }
  return out
}

/** 两份答案是否等价。选择题按集合比（多选顺序无关），填空按顺序比。 */
export function answersEqual(a, b) {
  if (!a || !b || a.type !== b.type) return false
  if (a.type === "choice") {
    const ka = new Set((a.keys ?? []).map((k) => String(k).toUpperCase()))
    const kb = new Set((b.keys ?? []).map((k) => String(k).toUpperCase()))
    if (ka.size !== kb.size) return false
    for (const k of ka) if (!kb.has(k)) return false
    return true
  }
  if (a.type === "tf") return a.value === b.value
  if (a.type === "blank") {
    const va = (a.values ?? []).map((v) => String(v ?? "").trim())
    const vb = (b.values ?? []).map((v) => String(v ?? "").trim())
    return va.length === vb.length && va.every((v, i) => v === vb[i])
  }
  if (a.type === "text") {
    // 主观题只认"逐字相同"（去空白）。这里主要给 answersEqual 的调用方一个闭环，
    // 判冲突时 answersConflict 会先把主观题排除掉。
    const sa = (a.samples ?? []).map((s) => String(s ?? "").replace(/\s+/g, ""))
    const sb = (b.samples ?? []).map((s) => String(s ?? "").replace(/\s+/g, ""))
    return sa.length === sb.length && sa.every((v, i) => v === sb[i])
  }
  return false
}

// 只有这几种题型的答案可以机械比较；主观题不判冲突（措辞差异是常态）
export const CONFLICT_QTYPES = ["single_choice", "multiple_choice", "true_false", "fill_blank"]

/** 两份答案算不算「冲突」。主观题一律不算——否则每条都要教师点一次，标记就废了。 */
export function answersConflict(qtype, a, b) {
  if (!a || !b) return false
  if (!CONFLICT_QTYPES.includes(qtype)) return false
  return !answersEqual(a, b)
}

// 单份答案的文字摘要（预览页一行显示用）
export function answerTextOfAnswer(a) {
  if (!a || typeof a !== "object") return null
  if (a.type === "choice") return a.keys?.length ? a.keys.join("") : null
  if (a.type === "tf") return a.value === true ? "对" : a.value === false ? "错" : null
  if (a.type === "blank") {
    const vs = (a.values ?? []).filter((v) => String(v ?? "").trim() !== "")
    return vs.length ? vs.join(" / ") : null
  }
  if (a.type === "text") {
    const ss = (a.samples ?? []).filter(Boolean)
    return ss.length ? ss[0].slice(0, 24) + (ss[0].length > 24 ? "…" : "") : null
  }
  return null
}

/**
 * 一道题（content）的答案摘要。复合题以前一律返回 null（预览上永远显示"未指定答案"），
 * 这里改成按小问编号拼起来——教师至少能一眼看出小问有没有答案。
 */
export function answerTextOf(content) {
  const own = answerTextOfAnswer(content?.answer)
  if (own) return own
  const subs = Array.isArray(content?.sub) ? content.sub : []
  if (subs.length === 0) return null
  const parts = []
  subs.forEach((s, i) => {
    const t = answerTextOfAnswer(s?.answer)
    if (t) parts.push(`${i + 1}.${t}`)
  })
  return parts.length ? parts.join(" ") : null
}
