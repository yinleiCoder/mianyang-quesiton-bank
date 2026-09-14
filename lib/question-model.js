// 题目模型纯函数（前后端共用）：题型/状态元数据、内容结构序列化、客户端校验
// 内容契约见迁移 0003 validate_question_content/v_simple_question——本文件与之逐条对齐，
// 提交前先在此拦截，错误信息风格与 DB raise exception 一致。
// 块(block)：{"t":"text","text":...} | {"t":"media","kind":"image|audio|video|file","key":..,"url":..,"alt":"原始文件名(文件块)"}
// 媒体插入已启用（OSS 直传 qbank/…，见 components/media-uploader）；选项纯文字（编辑器 noMedia 无入口），文本段落编辑始终可用。

export const FORMAT_VERSION = 1

export const QTYPES = [
  { value: "single_choice", label: "单选题" },
  { value: "multiple_choice", label: "多选题" },
  { value: "true_false", label: "判断题" },
  { value: "fill_blank", label: "填空题" },
  { value: "short_answer", label: "主观题（简答/解答/论述）", short: "主观题" },
  { value: "composite", label: "复合题（材料+子题）", short: "复合题" },
]
export const qtypeLabel = (v) => QTYPES.find((q) => q.value === v)?.label ?? v
// 紧凑处（工作台「最近入库」的定宽徽标列等）用简称：完整名称 10 字以上，
// 塞进 3 字宽的徽标会溢出容器盖住相邻题干；未定义 short 的题型回落完整名称。
export const qtypeShortLabel = (v) => QTYPES.find((q) => q.value === v)?.short ?? qtypeLabel(v)

export const DIFFICULTIES = [
  { value: 1, label: "易" },
  { value: 2, label: "中" },
  { value: 3, label: "难" },
]
export const difficultyLabel = (v) => DIFFICULTIES.find((d) => d.value === v)?.label ?? String(v)

// 版本状态 → 徽标
export const VERSION_STATUS = {
  draft: { text: "草稿", cls: "bg-muted text-muted-foreground" },
  pending_group: { text: "组长审核中", cls: "bg-amber-100 text-amber-700" },
  pending_city: { text: "专家审核中", cls: "bg-orange-100 text-orange-700" },
  published: { text: "已入库", cls: "bg-emerald-100 text-emerald-700" },
  superseded: { text: "已被新版本替换", cls: "bg-muted text-muted-foreground" },
  returned: { text: "已退回", cls: "bg-rose-100 text-rose-700" },
  retracted: { text: "已撤回", cls: "bg-muted text-muted-foreground" },
}
export const statusChip = (status) =>
  VERSION_STATUS[status] ?? { text: status, cls: "bg-muted text-muted-foreground" }

// ---------- 块工具 ----------
// 纯文本（媒体块不计入——与 DB v_blocks_text/检索口径一致；含媒体题空位计数在 M3B 复核）
export function blocksToText(blocks) {
  return (blocks ?? []).filter((b) => b?.t === "text").map((b) => b.text ?? "").join("")
}
// DB 空位口径：连续 3+ 下划线
export const countBlanks = (s = "") => (s.match(/_{3,}/g) || []).length

let __id = 0
const genId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `id_${Date.now()}_${++__id}`)

// ---------- 编辑器草稿状态（内部态：选项用 id 标识，落库时按序生成字母 key） ----------
export function makeOption() {
  return { id: genId(), label: [] }
}

// 默认四个空选项（选择题起始态）
export const makeOptions = (n = 4) => Array.from({ length: n }, makeOption)

export function defaultDraft() {
  return {
    qtype: "single_choice",
    difficulty: 2,
    nodeId: null,
    stem: [],
    options: makeOptions(),
    selection: null, // 单选：option id
    multiSelection: [], // 多选：option id[]
    tfValue: true,
    blanks: [], // 空位答案（与题干空位同步长度）
    samples: "", // 主观题参考答案（换行分段）
    subs: [], // 复合题子题
    nextSubId: 1,
    analysis: [], // 解析
    tags: [], // {id,name}
  }
}

export function defaultSub(type = "single_choice") {
  return {
    id: 0,
    type,
    stem: [],
    options: makeOptions(),
    selection: null,
    multiSelection: [],
    tfValue: true,
    blanks: [],
    samples: "",
  }
}

// 切换题型时重建作答面板：面板字段对所有题型统一存在（各题型只读自己那几个），
// 故与题型无关——题干保留，选项/答案回到初始态。
export function blankPanel({ stem = [] } = {}) {
  return {
    stem,
    options: makeOptions(),
    selection: null,
    multiSelection: [],
    tfValue: true,
    blanks: [],
    samples: "",
  }
}

// ---------- 内容序列化（写库契约） ----------
// 选项序号 → 选项字母（A/B/C…），编辑器与落库共用
export const optionLetter = (i) => String.fromCharCode(65 + i)

// 选择题（单选/多选共用选项与答案契约）
export const isChoiceType = (qtype) => qtype === "single_choice" || qtype === "multiple_choice"

export function serializeOne(qtype, s) {
  const c = { format_version: FORMAT_VERSION, stem: s.stem }
  if (s.analysis && s.analysis.length > 0) c.analysis = s.analysis
  if (isChoiceType(qtype)) {
    c.options = s.options.map((o, i) => ({ key: optionLetter(i), label: o.label }))
    const ids = qtype === "single_choice" ? (s.selection ? [s.selection] : []) : s.multiSelection
    c.answer = {
      type: "choice",
      keys: ids.map((id) => optionLetter(s.options.findIndex((o) => o.id === id))),
    }
  } else if (qtype === "true_false") {
    c.answer = { type: "tf", value: s.tfValue }
  } else if (qtype === "fill_blank") {
    c.answer = { type: "blank", values: s.blanks }
  } else if (qtype === "short_answer") {
    c.answer = { type: "text", samples: s.samples.split(/\n+/).map((x) => x.trim()).filter(Boolean) }
  }
  return c
}

export function serializeContent(d) {
  if (d.qtype === "composite") {
    const content = {
      format_version: FORMAT_VERSION,
      stem: d.stem,
      // 子题内容契约要求每个元素带 type（DB 复合题校验按 s->>'type' 分发）；serializeOne 不输出 type，此处补齐
      sub: d.subs.map((sub) => ({ type: sub.type, ...serializeOne(sub.type, sub) })),
    }
    if (d.analysis && d.analysis.length > 0) content.analysis = d.analysis
    return content
  }
  return serializeOne(d.qtype, d)
}

// ---------- 校验（错误数组非空 = 不通过；定位信息带前缀） ----------
function ensure(cond, msg, errors) {
  if (!cond) errors.push(msg)
}

function validateChoice(qtype, s, errors, p) {
  ensure(s.options.length >= 2, p("至少提供 2 个选项"), errors)
  s.options.forEach((o) => {
    ensure(blocksToText(o.label).trim().length > 0, p(`选项不能为空`), errors)
  })
  const chosen = qtype === "single_choice" ? (s.selection ? [s.selection] : []) : s.multiSelection
  ensure(chosen.length > 0, p(qtype === "single_choice" ? "请选择正确答案" : "请勾选正确答案"), errors)
  ensure(chosen.every((id) => s.options.some((o) => o.id === id)), p("答案不在选项中"), errors)
}

export function validateOne(qtype, s, errors, prefix = "") {
  const p = (m) => `${prefix}${m}`
  ensure(blocksToText(s.stem).trim().length > 0, p("题干不能为空"), errors)
  if (isChoiceType(qtype)) validateChoice(qtype, s, errors, p)
  if (qtype === "true_false") ensure(typeof s.tfValue === "boolean", p("请选择对/错"), errors)
  if (qtype === "fill_blank") {
    const need = countBlanks(blocksToText(s.stem))
    ensure(need > 0, p("填空题题干需包含空位（连续 3 个以上下划线，如：___）"), errors)
    ensure(
      s.blanks.length === need && s.blanks.every((b) => b.trim().length > 0),
      p("空位数量与答案数量需一致且答案不能为空"), errors
    )
  }
  if (qtype === "short_answer") ensure(s.samples.trim().length > 0, p("主观题需提供参考答案"), errors)
}

// 校验：requireTags=false 用于"保存草稿"（内容需结构完整，标签可后补）
export function validateContent(d, { requireTags = true } = {}) {
  const errors = []
  if (d.qtype === "composite") {
    ensure(blocksToText(d.stem).trim().length > 0, "复合题需提供材料题干", errors)
    ensure(d.subs.length >= 1, "复合题至少包含 1 个子题", errors)
    ensure(d.subs.length <= 20, "复合题子题最多 20 道", errors)
    d.subs.forEach((sub, i) => {
      if (sub.type === "composite") errors.push(`子题 ${i + 1}：子题不能嵌套复合题`)
      else validateOne(sub.type, sub, errors, `子题 ${i + 1}：`)
    })
  } else {
    validateOne(d.qtype, d, errors)
  }
  ensure(blocksToText(d.analysis).trim().length > 0, "请填写解析（解析对教学/纠错很重要）", errors)
  if (requireTags && d.tags.length === 0) errors.push("请至少打 1 个知识点标签")
  return errors
}

// ---------- 从已存内容还原（编辑被退回/在途版本） ----------
export function fromContentOne(qtype, content) {
  const s = {
    type: qtype,
    stem: Array.isArray(content.stem) ? content.stem : [],
    options: [],
    selection: null,
    multiSelection: [],
    tfValue: content.answer?.type === "tf" ? Boolean(content.answer.value) : true,
    blanks: qtype === "fill_blank" ? [...(content.answer?.values ?? [])] : [],
    samples: qtype === "short_answer" ? (content.answer?.samples ?? []).join("\n") : "",
  }
  const opts = Array.isArray(content.options) ? content.options : []
  s.options = opts.map((o) => ({ id: genId(), label: Array.isArray(o.label) ? o.label : [] }))
  const keys = content.answer?.type === "choice" ? content.answer.keys ?? [] : []
  if (qtype === "single_choice" && keys[0]) {
    const i = opts.findIndex((o) => o.key === keys[0])
    if (i >= 0) s.selection = s.options[i].id
  } else if (qtype === "multiple_choice") {
    s.multiSelection = keys
      .map((k) => {
        const i = opts.findIndex((o) => o.key === k)
        return i >= 0 ? s.options[i].id : null
      })
      .filter(Boolean)
  }
  if (s.options.length === 0) {
    s.options = [makeOption(), makeOption()]
  }
  return s
}

export function fromContent(qtype, difficulty, content, tags = []) {
  const d = defaultDraft()
  d.qtype = qtype
  d.difficulty = difficulty ?? 2
  d.analysis = Array.isArray(content.analysis) ? content.analysis : []
  d.tags = [...(tags ?? [])]
  if (qtype === "composite") {
    d.stem = Array.isArray(content.stem) ? content.stem : []
    d.subs = (content.sub ?? []).map((sub, i) => ({
      id: i + 1,
      ...fromContentOne(sub.type ?? "short_answer", sub),
    }))
    d.nextSubId = d.subs.length + 1
  } else {
    const one = fromContentOne(qtype, content)
    d.stem = one.stem
    d.options = one.options
    d.selection = one.selection
    d.multiSelection = one.multiSelection
    d.tfValue = one.tfValue
    d.blanks = one.blanks
    d.samples = one.samples
  }
  return d
}

// 摘要文本（列表展示/审批预览）：题干+（复合题各子题题干），不含答案
export function contentSummary(content) {
  const parts = [blocksToText(content?.stem)]
  for (const sub of content?.sub ?? []) parts.push(blocksToText(sub?.stem))
  return parts.filter(Boolean).join(" ")
}
