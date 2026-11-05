// 「科学抽题算法动画」的数据自检：分镜时间轴 + 画面上的数学。
// 运行：npm run test:showcase
//
// 为什么值得测：动画里的曲线与数字是**用生产公式现算的**（lib/showcase-scheduler.js
// 引 practice-scheduler-reference.js）。公式一旦被改坏，画面不会报错，只会安静地
// 画出一条错的曲线 —— 这组断言就是拦这种情况。
import assert from "node:assert/strict"
import {
  BKT_BRANCHES,
  BKT_INFO_CURVE,
  BKT_INFO_PEAK,
  BKT_LADDER,
  FORGETTING_CURVES,
  FSRS_LADDER,
  FSRS_WRONG_RESULT,
  REASON_LABELS,
  RETENTION_MARKERS,
  SCHEDULER_DURATION,
  SCHEDULER_SCENES,
  SCHEDULER_VIDEO,
  SCORE_SUSPECTS,
  balancedScore,
  sceneOf,
} from "@/lib/showcase-scheduler"

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

ok("分镜连续且总帧数自洽", () => {
  assert.ok(SCHEDULER_SCENES.length >= 8, "至少 8 个分镜")
  assert.equal(SCHEDULER_SCENES[0].from, 0)
  for (let i = 1; i < SCHEDULER_SCENES.length; i += 1) {
    const prev = SCHEDULER_SCENES[i - 1]
    const scene = SCHEDULER_SCENES[i]
    assert.equal(scene.from, prev.from + prev.duration, `分镜 ${scene.id} 与上一段不相接`)
    assert.ok(scene.duration > 0)
    assert.ok(scene.label && scene.label.length > 0, `分镜 ${scene.id} 缺章节名`)
  }
  const last = SCHEDULER_SCENES[SCHEDULER_SCENES.length - 1]
  assert.equal(last.from + last.duration, SCHEDULER_DURATION)
  assert.ok(close(SCHEDULER_DURATION / SCHEDULER_VIDEO.fps, 124.5, 0.5), "总时长应在 2 分钟左右")
})

ok("分镜 id 唯一，且 sceneOf 能反查", () => {
  const ids = new Set()
  for (const scene of SCHEDULER_SCENES) {
    assert.ok(!ids.has(scene.id), `分镜 id 重复：${scene.id}`)
    ids.add(scene.id)
    assert.equal(sceneOf(scene.id)?.from, scene.from)
  }
  assert.equal(sceneOf("not-a-scene"), null)
})

ok("可提取性：R(0)=1，R(S,S)=0.9，且随天数单调不增", () => {
  for (const marker of RETENTION_MARKERS) {
    assert.ok(close(marker.r, 0.9, 1e-9), `S=${marker.stability} 时 R(S,S) 应为 0.9`)
  }
  for (const curve of FORGETTING_CURVES) {
    assert.ok(close(curve.points[0].r, 1, 1e-12), "第 0 天应为 1")
    for (let i = 1; i < curve.points.length; i += 1) {
      assert.ok(
        curve.points[i].r <= curve.points[i - 1].r + 1e-12,
        `曲线 S=${curve.stability} 在第 ${curve.points[i].day} 天回升了`
      )
    }
  }
})

ok("FSRS 阶梯：答对拉长、间隔不缩短、180 天封顶", () => {
  for (let i = 1; i < FSRS_LADDER.length; i += 1) {
    assert.ok(
      FSRS_LADDER[i].stability > FSRS_LADDER[i - 1].stability,
      "答对后稳定性必须增大"
    )
    assert.ok(
      FSRS_LADDER[i].interval >= FSRS_LADDER[i - 1].interval,
      "间隔必须单调不减"
    )
    assert.ok(FSRS_LADDER[i].interval <= 180, "间隔不得超过 180 天")
    assert.ok(FSRS_LADDER[i].day > FSRS_LADDER[i - 1].day, "日期必须向前走")
  }
  assert.equal(FSRS_LADDER[0].interval, 2, "首次答对后应 2 天后再见")
})

ok("FSRS 答错：稳定性与间隔都被压短", () => {
  assert.ok(FSRS_WRONG_RESULT.after < FSRS_WRONG_RESULT.before)
  assert.ok(FSRS_WRONG_RESULT.intervalAfter < FSRS_WRONG_RESULT.intervalBefore)
  assert.ok(FSRS_WRONG_RESULT.after >= 0.01, "不会归零")
  assert.ok(FSRS_WRONG_RESULT.difficultyAfter >= FSRS_WRONG_RESULT.difficultyBefore)
})

ok("BKT：答对上升、答错下降，且都不会到 0 或 1", () => {
  assert.ok(BKT_BRANCHES.correct > BKT_BRANCHES.start)
  assert.ok(BKT_BRANCHES.wrong < BKT_BRANCHES.start)
  for (let i = 1; i < BKT_LADDER.corrects.length; i += 1) {
    assert.ok(BKT_LADDER.corrects[i].p > BKT_LADDER.corrects[i - 1].p)
    assert.ok(BKT_LADDER.wrongs[i].p < BKT_LADDER.wrongs[i - 1].p)
  }
  const lastWrong = BKT_LADDER.wrongs[BKT_LADDER.wrongs.length - 1].p
  assert.ok(lastWrong > 0.1, `连错后仍应大于 10%（实际 ${lastWrong.toFixed(3)}）`)
  const lastCorrect = BKT_LADDER.corrects[BKT_LADDER.corrects.length - 1].p
  assert.ok(lastCorrect < 1)
})

ok("信息增益落在 [0, ln2]，峰值在 p ≈ 0.5", () => {
  for (const point of BKT_INFO_CURVE) {
    assert.ok(point.gain >= 0, "信息增益不能为负")
    assert.ok(point.gain <= Math.LN2 + 1e-9, "信息增益不能超过 ln2")
  }
  assert.ok(Math.abs(BKT_INFO_PEAK.p - 0.5) <= 0.08, `峰值应在 0.5 附近，实际 ${BKT_INFO_PEAK.p}`)
})

ok("打分：总分等于五项之和，且候选按分数降序", () => {
  for (const item of SCORE_SUSPECTS) {
    const sum =
      item.parts.r + item.parts.need + item.parts.zpd + item.parts.info + item.parts.coverage
    assert.ok(close(sum, item.parts.total, 1e-12), `${item.id} 的分项与总分不一致`)
    const recomputed = balancedScore(item)
    assert.ok(close(recomputed.total, item.parts.total, 1e-12), "同一输入必须得同一分数")
  }
  for (let i = 1; i < SCORE_SUSPECTS.length; i += 1) {
    assert.ok(
      SCORE_SUSPECTS[i - 1].parts.total >= SCORE_SUSPECTS[i].parts.total,
      "候选必须按总分降序排列"
    )
  }
})

ok("四类推荐理由都有学生能读懂的中文", () => {
  for (const code of ["new_item", "due_review", "weak_node", "mastered"]) {
    assert.ok(REASON_LABELS[code], `缺少 reason_code ${code} 的文案`)
  }
})

console.log(`\n${passed} 组断言全部通过`)
