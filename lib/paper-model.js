// 试卷布局与提交预检（纯函数）。计分点模型见 lib/paper-units.js。
//
// 为什么拆开：计分点展开（每题/每空/每小问、复合题按空拆）是一套独立的规则，
// 要和迁移 0102 的 public.paper_item_units 逐条对齐；布局与预检只读它的结果。
// 两边混在一个文件里，改计分规则时很容易把标题/预检一起碰坏。
import { round2, scoreModeLabel } from "@/lib/paper-units"

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
  // 未入库的题也会 stale=true（它没有 current_published_version_id），
  // 但那是"还没入库"，不是"题库有新版本"。两者分开，否则 AI 成卷后会同时看到
  // 「尚未入库」和「请点刷新题目」，而刷新对草稿题只会报"无法刷新"。
  const stale = sections.flatMap((s) =>
    (s.items ?? []).filter((it) => it.available !== false && it.stale)
  )
  if (stale.length > 0) {
    issues.push(`有 ${stale.length} 道题在题库中已更新到新版本，请点「刷新题目」`)
  }
  if (paper?.target_score != null && Number(paper.target_score) !== total) {
    const diff = round2(total - Number(paper.target_score))
    issues.push(`全卷合计 ${total} 分与设定的总分 ${Number(paper.target_score)} 分不一致（相差 ${diff} 分）`)
  }
  return issues
}
