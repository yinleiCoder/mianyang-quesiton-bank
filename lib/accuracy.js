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
