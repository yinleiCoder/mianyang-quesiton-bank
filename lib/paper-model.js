// 试卷模型纯函数（前后端共用）。
// 分值展开口径必须与迁移 0044 的 public.paper_item_units 逐条一致——
// 同 draftIssues 对齐 validate_question_content 的约定：客户端只做即时预览，
// 落库的分值一律以服务端算出的 score_units / score 为准，本文件不产出真相。
//
// 为什么口径落在"计分点"而不是"题"上：需求要的是"每空的分数"。
// 一道三空的填空题在 per_blank 口径下就是 3 个计分点，各得 score_each 分；
// 复合题的 per_sub 同理。这样"部分给分"从数据结构层面就是天然的。

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
  if (mode === "per_blank" && qtype === "fill_blank") return "per_blank"
  if (mode === "per_sub" && qtype === "composite") return "per_sub"
  return "per_item"
}

// 该题在这套口径下有几个计分点
export function unitCount(mode, qtype, content) {
  const m = effectiveScoreMode(mode, qtype)
  if (m === "per_blank") return Math.max(countBlanks(blocksToText(content?.stem)), 1)
  if (m === "per_sub") return Math.max((content?.sub ?? []).length, 1)
  return 1
}

// 展开成计分点明细。custom 非空 = 教师对这一题做了显式定制，直接采用。
export function expandUnits({ mode, qtype, content, scoreEach, custom }) {
  if (Array.isArray(custom) && custom.length > 0) return custom.map(Number)
  const n = unitCount(mode, qtype, content)
  const each = Number(scoreEach) || 0
  return Array.from({ length: n }, () => each)
}

export const sumUnits = (units) => (units ?? []).reduce((a, b) => a + Number(b || 0), 0)

// 浮点累加会出现 0.30000000000000004 这类结果，展示前统一收敛到两位小数
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

// 中文序号（一、二、…）。服务端 cn_numeral 是同一份口径，这里供编辑器即时预览用。
export function cnNumeral(n) {
  const d = ["一", "二", "三", "四", "五", "六", "七", "八", "九"]
  if (n >= 1 && n <= 10) return n === 10 ? "十" : d[n - 1]
  if (n > 10 && n < 20) return `十${d[n - 11]}`
  if (n >= 20 && n < 100) return `${d[Math.floor(n / 10) - 1]}十${n % 10 ? d[(n % 10) - 1] : ""}`
  return String(n)
}

// 打印与详情页共用的大题标题：一、单项选择题（共 32 题，每题 3 分，共 96 分）
// 分值描述按口径取"每题/每空/每小问"，与卷面实际计分方式一致——
// 卷面上写"每题3分"而系统按每空给分，是会让学生当场发火的错。
export function sectionHeading(section, index = 0) {
  const label = section.seq_label ?? cnNumeral(index + 1)
  const count = section.items?.length ?? section.item_count ?? 0
  const total = sectionScore(section)
  const mode = scoreModeLabel(section.score_mode, dominantQtype(section))
  const head = `${label}、${section.title || "未命名大题"}`
  if (count === 0) return `${head}（暂无题目）`

  // 分值描述说的是**每个计分点**多少分，所以取大题的 score_each，
  // 不能取题目的 score——一个三空的填空题在「每空 2 分」下整题是 6 分，
  // 拿整题分去填这句会写成"每空 6 分，共 6 分"，自相矛盾。
  // 有大题内被单独设过分值的题时，一句话概括不了，退回只报总数。
  const each = Number(section.score_each) || 0
  const hasCustom = (section.items ?? []).some((i) => i.custom_units?.length > 0)
  if (hasCustom || each <= 0) return `${head}（共 ${count} 题，共 ${round2(total)} 分）`
  return `${head}（共 ${count} 题，${mode} ${round2(each)} 分，共 ${round2(total)} 分）`
}

export const sectionScore = (section) =>
  section?.section_score != null
    ? Number(section.section_score)
    : round2((section?.items ?? []).reduce((a, i) => a + Number(i.score || 0), 0))

// 大题里出现最多的题型，用来决定"每题/每空/每小问"的措辞
function dominantQtype(section) {
  const items = section?.items ?? []
  if (items.length === 0) return null
  const counts = {}
  for (const i of items) counts[i.qtype] = (counts[i.qtype] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
}

export const paperTotal = (sections) =>
  round2((sections ?? []).reduce((a, s) => a + sectionScore(s), 0))

export const paperItemCount = (sections) =>
  (sections ?? []).reduce((a, s) => a + (s.items?.length ?? 0), 0)

// 提交前的本地预检：把 DB 的硬校验提前到 UI 可见。
// **不替代**服务端校验——submit_paper 里的检查才是权威，这里只是让教师少跑一趟。
export function paperIssues(paper) {
  const sections = paper?.sections ?? []
  const issues = []
  const total = paperTotal(sections)
  const count = paperItemCount(sections)

  if (count === 0) issues.push("试卷还没有任何题目")
  for (const [i, sec] of sections.entries()) {
    if ((sec.items ?? []).length === 0) {
      issues.push(`大题「${sec.title || cnNumeral(i + 1)}」下面还没有题目`)
    }
  }
  const notReady = sections.flatMap((s, si) =>
    (s.items ?? [])
      .map((it, ii) => ({ it, label: `${si + 1}-${ii + 1}` }))
      .filter(({ it }) => it.available === false)
  )
  if (notReady.length > 0) {
    issues.push(`有 ${notReady.length} 道题尚未入库或已下线，需先在题库完成入库`)
  }
  const stale = sections.flatMap((s) => (s.items ?? []).filter((it) => it.stale))
  if (stale.length > 0) {
    issues.push(`有 ${stale.length} 道题在题库中已更新到新版本，请点「刷新题目」`)
  }
  if (paper?.target_score != null && Number(paper.target_score) !== total) {
    const diff = round2(total - Number(paper.target_score))
    issues.push(`全卷合计 ${total} 分与设定的总分 ${Number(paper.target_score)} 分不一致（相差 ${diff} 分）`)
  }
  return issues
}
