// 艾宾浩斯遗忘曲线的理论值（纯函数，前后端都可引用）。
//
// 与 Flutter 端 utils/forgetting_curve.dart **逐条一致**：两端各画一张同样的参照线，
// 口径分叉的话同一份数据在网页和手机上会给出不同的"你比理论线高/低"。
//
// 为什么理论线不进数据库：它是常量，与任何用户数据无关（0067 的注释）。
// 学生自己的实测点来自 practice_dashboard / my_student_detail 的 forgetting_curve。

// 经典锚点（天 → 保持率）。取自被引用最广的那组数：
// 20 分钟 58%、1 小时 44%、9 小时 36%、1 天 33%、2 天 28%、6 天 25%、31 天 21%。
// **不要随手改**：改了整条理论线就跟着变，它唯一的用处就是当参照物。
const ANCHORS = [
  [0, 1.0],
  [20 / 1440, 0.58],
  [1 / 24, 0.44],
  [9 / 24, 0.36],
  [1, 0.33],
  [2, 0.28],
  [6, 0.25],
  [31, 0.21],
]

// 31 天之后走平：经典那组数到 21% 就基本不动了，继续外推是编出来的数。
const FLOOR = 0.21

/** 距学完 [days] 天后的理论保持率（0~1）。负天数按 0 处理。 */
export function ebbinghausRetention(days) {
  const t = days <= 0 ? 0 : days
  if (t >= ANCHORS[ANCHORS.length - 1][0]) return FLOOR

  for (let i = 1; i < ANCHORS.length; i++) {
    const [x1, y1] = ANCHORS[i]
    if (t > x1) continue
    const [x0, y0] = ANCHORS[i - 1]
    // 0 天与 20 分钟之间取线性：对数轴在 0 处没定义
    const ratio =
      x0 === 0
        ? t / x1
        : (Math.log(t) - Math.log(x0)) / (Math.log(x1) - Math.log(x0))
    return y0 + (y1 - y0) * ratio
  }
  return FLOOR
}

/** 画理论线用的采样点：0~maxDays 均匀取 count 段。 */
export function ebbinghausSamples({ maxDays = 30, count = 120 } = {}) {
  return Array.from({ length: count + 1 }, (_, i) => {
    const day = (maxDays * i) / count
    return [day, ebbinghausRetention(day)]
  })
}

// 样本可信门槛：每桶至少 3 次作答（与 Flutter forgetting_curve_card.dart 一致）。
export const RELIABLE_BUCKET_ATTEMPTS = 3

/** 把服务端返回的桶筛成可画的点：每桶 ≥3 次、按天数升序。 */
export function plottableBuckets(buckets = []) {
  return buckets
    .filter((b) => Number(b.attempts) >= RELIABLE_BUCKET_ATTEMPTS)
    .map((b) => ({
      days: Number(b.days),
      attempts: Number(b.attempts),
      correct: Number(b.correct),
      accuracy: Number(b.correct) / Number(b.attempts),
    }))
    .sort((a, b) => a.days - b.days)
}
