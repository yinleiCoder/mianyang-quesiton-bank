// 经典测验理论（CTT）的展示口径（纯函数，可单测）。
//
// 服务端 RPC 已经算好 p_value / p_se / r_pb 与各选项的 count / upper_count / lower_count；
// 这里只做百分比、上下 27% 差、标记、质量分与 A-D 分档。阈值集中在这一处，
// 页面与测试用的是同一套口径。
//
// 术语：
//   · 难度 p：二分题=做对人数/作答人数；多分题=平均得分/满分；
//   · 区分度 r：题目得分与"其余题总分"的 Pearson 相关（点二列是其特例）；
//   · 上下 27%：按总分排序，高分组与低分组各取约 27% 的人；
//   · D = 高分组选中率 - 低分组选中率。正确项 D 应为正；干扰项 D 大 = 它太有吸引力。

export const CTT_MIN_DISPLAY = 10
export const CTT_MIN_R = 30
export const CTT_MIN_DISTRACTOR = 10
export const CTT_MIN_UPPER_LOWER = 20

export function ratio(part, whole) {
  const p = Number(part) || 0
  const w = Number(whole) || 0
  return w > 0 ? p / w : null
}

export function pctText(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`
}

/** 难度指数的标准误；n=0 时无意义，返回 null。 */
export function pSe(p, n) {
  const value = p == null ? null : Number(p)
  const count = Number(n) || 0
  if (value == null || count <= 0) return null
  return Math.sqrt((value * (1 - value)) / count)
}

/** 把 RPC 返回的选项计数扩成展示口径：占比、上下 27% 占比、D。 */
export function optionRows(item, summary) {
  const n = Number(item?.n) || 0
  const k = Number(summary?.n_group) || 0
  return (item?.options ?? []).map((option) => {
    const pct = ratio(option.count, n)
    const upperPct = ratio(option.upper_count, k)
    const lowerPct = ratio(option.lower_count, k)
    return {
      ...option,
      pct,
      upper_pct: upperPct,
      lower_pct: lowerPct,
      d: upperPct != null && lowerPct != null ? upperPct - lowerPct : null,
    }
  })
}

export function rLabel(r) {
  if (r == null) return "样本不足"
  if (r < 0.10) return "差"
  if (r < 0.15) return "偏弱"
  if (r < 0.30) return "中"
  return "好"
}

/** 题目质量标记。severity: error > warn > info > muted。 */
export function buildFlags(item, summary, rows = optionRows(item, summary)) {
  const flags = []
  const n = Number(item?.n) || 0
  const p = item?.p_value == null ? null : Number(item.p_value)
  const r = item?.r_pb == null ? null : Number(item.r_pb)
  const blankRate = ratio(item?.blank, n)

  if (n < CTT_MIN_DISPLAY) {
    flags.push({ code: "insufficient", severity: "muted", message: `样本不足（${n} 人），仅作参考` })
  } else if (n < CTT_MIN_R) {
    flags.push({ code: "small_sample", severity: "info", message: `样本 ${n} 人，区分度仅供参考` })
  }

  if (p != null) {
    if (p < 0.15) flags.push({ code: "too_hard", severity: "warn", message: `难度 p=${p.toFixed(2)}，偏难` })
    else if (p > 0.95) flags.push({ code: "too_easy", severity: "warn", message: `难度 p=${p.toFixed(2)}，偏易` })
  }

  if (r != null) {
    if (r < 0.10) flags.push({ code: "poor_discrimination", severity: "warn", message: `区分度 r=${r.toFixed(2)}，偏弱` })
    else if (r < 0.15) flags.push({ code: "weak_discrimination", severity: "info", message: `区分度 r=${r.toFixed(2)}，偏弱` })
  }

  if (blankRate != null && blankRate > 0.20) {
    flags.push({ code: "high_blank", severity: "info", message: `未答率 ${pctText(blankRate)}` })
  }

  const keys = rows.filter((row) => row.is_key)
  if (n >= CTT_MIN_DISTRACTOR && keys.length > 0 && keys.every((row) => (Number(row.count) || 0) === 0)) {
    flags.push({ code: "key_never_chosen", severity: "error", message: "正确项无人选择，疑似答案键有误" })
  }

  if (n >= CTT_MIN_UPPER_LOWER) {
    for (const row of rows) {
      if (row.is_key) continue
      if (row.pct != null && row.d != null && row.pct >= 0.30 && row.d >= 0.10) {
        flags.push({
          code: "strong_distractor",
          severity: "warn",
          message: `选项 ${row.key} 被 ${pctText(row.pct)} 选中且高分组更偏好（D=${row.d.toFixed(2)}），可能多解或答案存疑`,
        })
      }
      if (row.pct != null && row.pct < 0.05) {
        flags.push({ code: "dead_distractor", severity: "info", message: `选项 ${row.key} 几乎无人选（<5%）` })
      }
    }
  }

  return flags
}

/** 100 分制质量分：极端难度、低区分度、强/无效干扰项、高未答率各扣分。 */
export function qualityScore(item, flags) {
  let score = 100
  const p = item?.p_value == null ? null : Number(item.p_value)
  const r = item?.r_pb == null ? null : Number(item.r_pb)

  if (p != null && (p < 0.15 || p > 0.95)) score -= 15
  if (r != null) {
    if (r < 0.10) score -= 20
    else if (r < 0.15) score -= 10
  }
  for (const flag of flags) {
    if (flag.code === "key_never_chosen") score -= 20
    else if (flag.code === "strong_distractor" || flag.code === "dead_distractor" || flag.code === "high_blank") score -= 8
  }
  return Math.max(0, Math.min(100, Math.round(score)))
}

export function gradeFor(score) {
  if (score >= 85) return "A"
  if (score >= 70) return "B"
  if (score >= 55) return "C"
  return "D"
}

/** 单题：在原 RPC 数据上补 options / flags / quality_score / grade / r_label。 */
export function analyzeItem(item, summary) {
  const rows = optionRows(item, summary)
  const flags = buildFlags(item, summary, rows)
  const score = qualityScore(item, flags)
  return {
    ...item,
    options: rows,
    flags,
    quality_score: score,
    grade: gradeFor(score),
    r_label: rLabel(item?.r_pb),
  }
}

/** 整卷：逐题分析 + A-D 计数 + 平均质量分 + 有风险题数。 */
export function summarizeQuality(items, summary) {
  const analyzed = (items ?? []).map((item) => analyzeItem(item, summary))
  const counts = { A: 0, B: 0, C: 0, D: 0 }
  for (const item of analyzed) counts[item.grade] += 1
  const flagged = analyzed.filter((item) =>
    item.flags.some((flag) => flag.severity === "warn" || flag.severity === "error")
  ).length
  const average = analyzed.length
    ? Math.round(analyzed.reduce((sum, item) => sum + item.quality_score, 0) / analyzed.length)
    : null
  return { items: analyzed, counts, flagged, average }
}
