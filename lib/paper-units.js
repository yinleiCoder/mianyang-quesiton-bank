// 试卷计分点模型（纯函数，前后端共用）。
//
// 分值展开口径必须与迁移 0102 的 public.paper_item_units 逐条一致：
// 客户端只做即时预览，落库的分值一律以服务端算出的 score_units / score 为准。
//
// 为什么口径落在"计分点"而不是"题"上：需求要的是"每空的分数"。
//   · 填空題 per_blank：一个空一个计分点；
//   · 复合题 per_sub：每个小问的总分仍是 score_each，均摊到它的各空；
//   · 复合题 per_blank：每个 fill_blank 子题的每一空都是 score_each；
//   · 其余：整题一个计分点。
import { countBlanks, blocksToText } from "@/lib/question-model"

export const SCORE_MODES = [
  { value: "per_item", label: "每题" },
  { value: "per_blank", label: "每空" },
  { value: "per_sub", label: "每小问" },
]

// 计分口径与题型不匹配时（per_blank 配选择题）退化为整题一个计分点。
// 不在 UI 上报错：教师改大题口径的过程中必然经过"暂时不匹配"的中间态。
export function scoreModeLabel(mode, qtype) {
  const m = effectiveScoreMode(mode, qtype)
  return SCORE_MODES.find((s) => s.value === m)?.label ?? "每题"
}

export function effectiveScoreMode(mode, qtype) {
  // per_blank 对填空题与复合题都生效：复合题里每个 fill_blank 子题的每一空算一个计分点。
  // per_sub 仍只对复合题生效：每个小问的**总分**是 score_each，均摊到它的各空。
  if (mode === "per_blank" && (qtype === "fill_blank" || qtype === "composite")) return "per_blank"
  if (mode === "per_sub" && qtype === "composite") return "per_sub"
  return "per_item"
}

// 复合题单个子题占几个计分点：填空题按空，其余题型整题一个。
function subUnitCount(sub) {
  if (sub?.type !== "fill_blank") return 1
  return Math.max(countBlanks(blocksToText(sub?.stem)), 1)
}

// 该题在这套口径下有几个计分点
export function unitCount(mode, qtype, content) {
  const m = effectiveScoreMode(mode, qtype)
  if (m === "per_blank" && qtype === "fill_blank") {
    return Math.max(countBlanks(blocksToText(content?.stem)), 1)
  }
  if (qtype === "composite" && (m === "per_blank" || m === "per_sub")) {
    const subs = Array.isArray(content?.sub) ? content.sub : []
    const n = subs.reduce((sum, sub) => sum + subUnitCount(sub), 0)
    return n > 0 ? n : 1
  }
  return 1
}

// 展开成计分点明细。custom 非空 = 教师对这一题做了显式定制，直接采用。
//
// 复合题 per_sub 的口径：每个小问的总分仍是 score_each，但均摊到它的各空
// （除不尽的余数给最后一空）。这样"每小问 2 分"的卷面总分不变，
// 只是把设置粒度从"每个小问"细化到"每一空"，教师仍可逐空改。
export function expandUnits({ mode, qtype, content, scoreEach, custom }) {
  if (Array.isArray(custom) && custom.length > 0) return custom.map(Number)
  const m = effectiveScoreMode(mode, qtype)
  const each = Number(scoreEach) || 0
  if (m === "per_item") return [each]
  if (qtype === "fill_blank") {
    const n = Math.max(countBlanks(blocksToText(content?.stem)), 1)
    return Array.from({ length: n }, () => each)
  }
  // composite
  const subs = Array.isArray(content?.sub) ? content.sub : []
  const out = []
  for (const sub of subs) {
    const n = subUnitCount(sub)
    if (m === "per_sub" && n > 1) {
      const base = round2(each / n)
      for (let j = 0; j < n; j++) {
        out.push(j < n - 1 ? base : round2(each - base * (n - 1)))
      }
    } else {
      for (let j = 0; j < n; j++) out.push(each)
    }
  }
  return out.length > 0 ? out : [each]
}

// 复合题按子题/空展开的标签（不带兜底填充）。
function compositeLayoutLabels(content) {
  const labels = []
  const subs = Array.isArray(content?.sub) ? content.sub : []
  subs.forEach((sub, i) => {
    const n = subUnitCount(sub)
    for (let j = 0; j < n; j++) {
      labels.push(n > 1 ? `第 ${i + 1} 小问第 ${j + 1} 空` : `第 ${i + 1} 小问`)
    }
  })
  return labels
}

// 分值输入框的标签。复合题按「第 N 小问第 M 空」标，避免一排输入框分不清是哪一空。
export function unitLabels(mode, qtype, content, count) {
  if (qtype === "composite") {
    const layout = compositeLayoutLabels(content)
    if (layout.length === count) return layout
    const subs = Array.isArray(content?.sub) ? content.sub : []
    if (subs.length === count) return subs.map((_, i) => `第 ${i + 1} 小问`)
  }
  const labels = []
  for (let i = labels.length; i < count; i++) {
    labels.push(count > 1 ? `第 ${i + 1} 空` : "本题")
  }
  return labels.slice(0, count)
}

// 把"整题一个数"或"每个小问一个数"细分成"每一空一个数"，总分不变。
//   · 长度 = 1：先按小问数均分，再按各小问的空数均分；
//   · 长度 = 小问数：每个小问的分数按它的空数均分；
//   · 已经是逐空长度：原样返回。
// 这是"复合题不能单独设每个空分数"的补丁：AI 成卷/旧卷的整题分、旧的按小问分
// 都能一键拆到空，教师再逐空改，不必推倒重来。
export function refineCompositeUnits(units, content) {
  const subs = Array.isArray(content?.sub) ? content.sub : []
  const layout = subs.map((sub) => subUnitCount(sub))
  const totalUnits = layout.reduce((a, b) => a + b, 0)
  const src = (units ?? []).map(Number)
  if (totalUnits === 0 || src.length === totalUnits) return src
  let perSub
  if (src.length === subs.length) {
    perSub = src
  } else if (src.length === 1) {
    const each = round2(src[0] / Math.max(subs.length, 1))
    perSub = subs.map((_, i) =>
      i < subs.length - 1 ? each : round2(src[0] - each * (subs.length - 1))
    )
  } else {
    return src
  }
  const out = []
  perSub.forEach((amount, i) => {
    const n = layout[i]
    if (n <= 1) {
      out.push(round2(amount))
      return
    }
    const base = round2(amount / n)
    for (let j = 0; j < n; j++) {
      out.push(j < n - 1 ? base : round2(amount - base * (n - 1)))
    }
  })
  return out
}

// 阅卷页只有已落库的 score_units，没有 score_mode：按计分点个数反推口径。
// 新口径（按空）的总数 = 各子题的（空数/1）之和；旧口径（按小问）等于子题数。
// compact=true 用于阅卷台：一排输入框放不下「第 2 小问第 3 空」，缩成「2-3」。
export function unitLabelsForItem(item, { compact = false } = {}) {
  const count = item?.score_units?.length ?? item?.units?.length ?? 1
  const label = (sub, blank, n) =>
    compact
      ? n > 1
        ? `${sub}-${blank}`
        : `${sub}`
      : n > 1
        ? `第 ${sub} 小问第 ${blank} 空`
        : `第 ${sub} 小问`
  if (item?.qtype === "composite") {
    const subs = Array.isArray(item.content?.sub) ? item.content.sub : []
    const layout = []
    subs.forEach((sub, i) => {
      const n = subUnitCount(sub)
      for (let j = 0; j < n; j++) layout.push(label(i + 1, j + 1, n))
    })
    if (layout.length === count) return layout
    if (subs.length === count) return subs.map((_, i) => (compact ? `${i + 1}` : `第 ${i + 1} 小问`))
    return Array.from({ length: count }, (_, i) => (compact ? `${i + 1}` : `第 ${i + 1} 点`))
  }
  if (compact && count > 1) return Array.from({ length: count }, (_, i) => `${i + 1}`)
  return Array.from({ length: count }, (_, i) => (count > 1 ? `第 ${i + 1} 空` : "本题"))
}

export const sumUnits = (units) => (units ?? []).reduce((a, b) => a + Number(b || 0), 0)

// 浮点累加会出现 0.30000000000000004 这类结果，展示前统一收敛到两位小数
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
