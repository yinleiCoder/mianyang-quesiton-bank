// 全站作答错误率（RPC question_accuracy 的结果）→ 展示口径的唯一来源。
//
// 为什么值得单独一个文件：**「0 次作答」不等于「错误率 0%」**。前者是没数据，后者是"所有人都做对了"，
// 题库列表与题目详情两处都要守这条，各写一份迟早分叉。
//
// 数据来源：practice_answers —— Flutter 端每答一题调 submit_practice_answer，服务端判分后写 is_correct
//（0028）。0029 的 question_accuracy 把它聚合成 (question_id, attempts, correct)，**只统计
// grading='auto' 的客观题**，主观自评题（grading='self'）不计入 —— 所以分母与"做过这道题的人数"并不严格相等。
//
// 注意：该 RPC 是 group by，没有作答记录的题**不会出现在结果里**（不是 attempts=0 的行），
// 调用方 map.get() 拿到 undefined 就是"没数据"，这是正常路径，不是异常。

// 错误率高于此值按"易错题"高亮。列表与详情共用一个阈值，免得两处颜色对不上。
export const HIGH_ERROR_RATE = 0.6

// **易错题还要够样本量**：错误率再高，2 个人做过、1 个人错了也叫"50% 错误率"，
// 标成易错只会把真正该讲的题挤下去。这条线是 2026-09-30 定的，与班级页
// 「最该讲的题」、学情告警同源；Flutter 端 `lib/values/accuracy_meta.dart` 有同一份
// （两端必须一致，改一处要改两处）。
export const MIN_ATTEMPTS_HIGH_ERROR = 5

/**
 * 易错题判定（唯一的判据，别在页面里另写一条线）。
 * @param errorRate 错误率（0~1）
 * @param sample    样本量：全站口径传 attempts，卷内口径传 graded（判过分的人数）
 */
export function isHighError(errorRate, sample) {
  const s = Number(sample)
  const r = Number(errorRate)
  return Number.isFinite(s) && Number.isFinite(r) && s >= MIN_ATTEMPTS_HIGH_ERROR && r >= HIGH_ERROR_RATE
}

/** question_accuracy 那一行的形状（全站口径）。无作答记录时传进来的是 undefined → false。 */
export const isEasilyWrong = (stat) => Boolean(stat) && isHighError(stat.errorRate, stat.attempts)

/** 全站错答**人次**（= 作答次数 - 答对次数）。注意它不是"错过这道题的人数"，也不是某个人的错误次数。 */
export const accuracyWrongCount = (stat) =>
  stat ? Math.max(0, (Number(stat.attempts) || 0) - (Number(stat.correct) || 0)) : 0

// 把 question_accuracy 的行转成 question_id → 统计量。无作答的题不在 map 里。
// attempts/correct 是 bigint，PostgREST 可能回字符串，统一转数字。
export function buildAccuracyMap(rows) {
  const map = new Map()
  for (const r of rows ?? []) {
    const attempts = Number(r.attempts) || 0
    if (attempts <= 0) continue
    const correct = Number(r.correct) || 0
    map.set(r.question_id, {
      attempts,
      correct,
      errorRate: 1 - correct / attempts,
    })
  }
  return map
}

// 错误率百分比文案；没有作答数据时返回 null。
// **返回 null 而不是 "0%"** —— 调用方必须显式区分这两种情况（见文件头）。
export function errorRatePercent(stat) {
  if (!stat || stat.attempts <= 0) return null
  return `${Math.round(stat.errorRate * 100)}%`
}
