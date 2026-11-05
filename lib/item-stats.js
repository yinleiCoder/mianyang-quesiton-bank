// 题目经验统计（纯函数，可单测）。
//
// 智能组卷不直接相信作者标注的难度：用真实练习作答做 Beta 收缩。
//   · attempts 少 → 向作者难度先验收缩，避免"做了 1 次就定难度"；
//   · attempts >= 5 → 用经验正确率分档（易 >=0.7 / 中 0.4~0.7 / 难 <0.4）。
// 口径与 lib/accuracy.js 的"易错题 >=5 次"一致：低于 5 次不给结论。

export const DIFFICULTY_PRIOR = { 1: 0.8, 2: 0.55, 3: 0.3 }
export const SHRINK_STRENGTH = 5
export const MIN_ATTEMPTS_FOR_EMPIRICAL = 5

export function priorFor(difficulty) {
  return DIFFICULTY_PRIOR[Number(difficulty)] ?? 0.55
}

/** Beta 收缩后的经验正确率：attempts 越少越接近作者难度先验。 */
export function shrunkDifficulty({ attempts, correct, difficulty } = {}) {
  const n = Math.max(0, Number(attempts) || 0)
  const c = Math.max(0, Number(correct) || 0)
  const prior = priorFor(difficulty)
  return (c + SHRINK_STRENGTH * prior) / (n + SHRINK_STRENGTH)
}

/**
 * 组卷配比用的"有效难度"：样本足够时按经验正确率分档，否则回落到作者难度。
 * 返回 1 易 / 2 中 / 3 难。
 */
export function effectiveDifficultyBand({ attempts, correct, difficulty } = {}) {
  const n = Number(attempts) || 0
  if (n < MIN_ATTEMPTS_FOR_EMPIRICAL) return Number(difficulty) || 2
  const p = shrunkDifficulty({ attempts: n, correct, difficulty })
  if (p >= 0.7) return 1
  if (p >= 0.4) return 2
  return 3
}

/** 最近 N 天被用过的次数 → 0~1 的曝光惩罚（封顶 3 次）。 */
export function exposurePenalty(uses) {
  return Math.min(Math.max(Number(uses) || 0, 0), 3) / 3
}
