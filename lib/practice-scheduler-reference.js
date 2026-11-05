// 回测专用的参考实现（纯 JS，不参与生产）。生产调度在 SQL：
// supabase/migrations/0125_practice_fsrs.sql + 0126_practice_plan.sql。
//
// 这里逐条复刻 FSRS-6 的 R/S 公式与 BKT 更新，用于在没有数据库写权限的情况下
// 按历史作答回放两种策略（FSRS 混合 vs 旧 0099 的 30% 到期 + 新题）。

export const FSRS6_WEIGHTS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]
const W = FSRS6_WEIGHTS
const DAY = 86400000

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function fsrsInitial(rating) {
  const r = clamp(Math.round(rating) || 3, 1, 4)
  return {
    stability: W[r - 1],
    difficulty: clamp(W[4] - Math.exp(W[5] * (r - 1)) + 1, 1, 10),
  }
}

export function fsrsRetrievability(stability, elapsedDays) {
  const s = Math.max(0.01, Number(stability) || 0.01)
  const t = Math.max(0, Number(elapsedDays) || 0)
  const factor = Math.pow(0.9, -1 / W[20]) - 1
  return clamp(Math.pow(1 + (factor * t) / s, -W[20]), 0, 1)
}

export function fsrsInterval(stability, retention = 0.9) {
  const s = Math.max(0.01, Number(stability) || 0.01)
  const r = clamp(Number(retention) || 0.9, 0.7, 0.98)
  const factor = Math.pow(0.9, -1 / W[20]) - 1
  return (s / factor) * (Math.pow(r, -1 / W[20]) - 1)
}

export function fsrsNext(stability, difficulty, elapsedDays, correct) {
  let s = Math.max(0.01, Number(stability) || 0.01)
  let d = clamp(Number(difficulty) || 5, 1, 10)
  const t = Math.max(0, Number(elapsedDays) || 0)
  const rating = correct ? 3 : 1
  const r = fsrsRetrievability(s, t)
  let nextS

  if (correct) {
    if (t < 0.5) {
      nextS = Math.max(s, s * Math.exp(W[17] * (rating - 3 + W[18])) * Math.pow(s, -W[19]))
    } else {
      nextS = s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1))
    }
  } else {
    nextS = Math.min(
      s,
      W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r))
    )
  }

  const d0Easy = fsrsInitial(4).difficulty
  const dStar = d + (-W[6] * (rating - 3) * (10 - d)) / 9
  d = clamp(W[7] * d0Easy + (1 - W[7]) * dStar, 1, 10)
  return { stability: clamp(nextS, 0.01, 36500), difficulty: d }
}

export function bktEntropy(p) {
  if (p == null || p <= 0 || p >= 1) return 0
  return -p * Math.log(p) - (1 - p) * Math.log(1 - p)
}

export function bktAfter(p, correct, g, s = 0.1, t = 0.15) {
  if (p == null) return null
  const posterior = correct
    ? (p * (1 - s)) / (p * (1 - s) + (1 - p) * g)
    : (p * s) / (p * s + (1 - p) * (1 - g))
  return posterior + (1 - posterior) * t
}

export function bktInfoGain(p, g, s = 0.1, t = 0.15) {
  if (p == null) return null
  const pCorrect = p * (1 - s) + (1 - p) * g
  const afterCorrect = (p * (1 - s)) / (p * (1 - s) + (1 - p) * g)
  const afterWrong = (p * s) / (p * s + (1 - p) * (1 - g))
  const expected = pCorrect * bktEntropy(afterCorrect) + (1 - pCorrect) * bktEntropy(afterWrong)
  return Math.max(0, bktEntropy(p) - expected)
}

export function guessProbability(qtype, optionCount) {
  if (qtype === "single_choice" || qtype === "multiple_choice") {
    return 1 / Math.max(Number(optionCount) || 4, 2)
  }
  if (qtype === "true_false") return 0.5
  return 0.05
}

export function beijingDayKey(iso) {
  const date = new Date(iso)
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000)
  return shifted.toISOString().slice(0, 10)
}

export function daysBetween(a, b) {
  return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / DAY)
}

/** 旧 0099 的复习间隔（连续答对 streak → 1/2/4/7/15/30 天）。 */
export const LEGACY_INTERVALS = [1, 2, 4, 7, 15, 30]

export function legacyDueAt(lastAt, streak) {
  const interval = LEGACY_INTERVALS[Math.min(Math.max(streak, 0), 5)]
  return new Date(new Date(lastAt).getTime() + interval * DAY).toISOString()
}
