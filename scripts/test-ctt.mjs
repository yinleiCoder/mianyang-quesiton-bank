// CTT 纯函数断言。不连库、不调模型。
// 运行：npm run test:ctt
import assert from "node:assert/strict"
import {
  analyzeItem,
  buildFlags,
  gradeFor,
  optionRows,
  pctText,
  pSe,
  qualityScore,
  rLabel,
  summarizeQuality,
} from "@/lib/ctt"

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

ok("难度标准误", () => {
  assert.equal(pSe(0.5, 100), 0.05)
  assert.equal(pSe(0, 100), 0)
  assert.equal(pSe(null, 100), null)
  assert.equal(pSe(0.5, 0), null)
})

ok("选项占比与上下 27% 的 D", () => {
  const item = {
    n: 10,
    options: [
      { key: "A", is_key: true, count: 7, upper_count: 3, lower_count: 1 },
      { key: "B", is_key: false, count: 3, upper_count: 0, lower_count: 2 },
    ],
  }
  const rows = optionRows(item, { n_group: 3 })
  assert.equal(rows[0].pct, 0.7)
  assert.equal(rows[0].upper_pct, 1)
  assert.equal(rows[0].lower_pct, 1 / 3)
  assert.ok(Math.abs(rows[0].d - (1 - 1 / 3)) < 1e-9)
  assert.equal(rows[1].pct, 0.3)
})

ok("偏难 + 低区分度 + 高未答率", () => {
  const item = { n: 100, p_value: 0.1, r_pb: 0.05, blank: 30, options: [] }
  const flags = buildFlags(item, { n_group: 27 })
  assert.ok(flags.some((f) => f.code === "too_hard"))
  assert.ok(flags.some((f) => f.code === "poor_discrimination"))
  assert.ok(flags.some((f) => f.code === "high_blank"))
})

ok("强干扰项与无效干扰项", () => {
  const item = {
    n: 100,
    p_value: 0.55,
    r_pb: 0.3,
    blank: 0,
    options: [
      { key: "A", is_key: true, count: 55, upper_count: 20, lower_count: 10 },
      { key: "B", is_key: false, count: 35, upper_count: 20, lower_count: 5 },
      { key: "C", is_key: false, count: 3, upper_count: 1, lower_count: 1 },
    ],
  }
  const rows = optionRows(item, { n_group: 27 })
  const flags = buildFlags(item, { n_group: 27 }, rows)
  assert.ok(flags.some((f) => f.code === "strong_distractor" && f.message.includes("B")))
  assert.ok(flags.some((f) => f.code === "dead_distractor" && f.message.includes("C")))
})

ok("正确项无人选择", () => {
  const item = {
    n: 100,
    p_value: 0,
    r_pb: 0,
    blank: 0,
    options: [
      { key: "A", is_key: true, count: 0, upper_count: 0, lower_count: 0 },
      { key: "B", is_key: false, count: 100, upper_count: 27, lower_count: 27 },
    ],
  }
  const flags = buildFlags(item, { n_group: 27 })
  assert.ok(flags.some((f) => f.code === "key_never_chosen" && f.severity === "error"))
})

ok("样本不足只给提示", () => {
  const item = { n: 5, p_value: 0.4, r_pb: 0.2, blank: 0, options: [] }
  const flags = buildFlags(item, { n_group: 1 })
  assert.ok(flags.some((f) => f.code === "insufficient" && f.severity === "muted"))
})

ok("质量分与 A-D 分档", () => {
  assert.equal(qualityScore({ p_value: 0.6, r_pb: 0.4 }, []), 100)
  assert.equal(qualityScore({ p_value: 0.1, r_pb: 0.05 }, []), 65)
  assert.equal(gradeFor(100), "A")
  assert.equal(gradeFor(85), "A")
  assert.equal(gradeFor(70), "B")
  assert.equal(gradeFor(55), "C")
  assert.equal(gradeFor(54), "D")
})

ok("区分度标签", () => {
  assert.equal(rLabel(null), "样本不足")
  assert.equal(rLabel(0.05), "差")
  assert.equal(rLabel(0.12), "偏弱")
  assert.equal(rLabel(0.2), "中")
  assert.equal(rLabel(0.4), "好")
})

ok("分析单题并汇总整卷", () => {
  const good = {
    n: 100,
    p_value: 0.62,
    r_pb: 0.41,
    blank: 2,
    options: [
      { key: "A", is_key: true, count: 62, upper_count: 24, lower_count: 10 },
      { key: "B", is_key: false, count: 38, upper_count: 3, lower_count: 17 },
    ],
  }
  const bad = {
    n: 100,
    p_value: 0.1,
    r_pb: 0.05,
    blank: 30,
    options: [
      { key: "A", is_key: true, count: 10, upper_count: 4, lower_count: 2 },
      { key: "B", is_key: false, count: 40, upper_count: 18, lower_count: 5 },
      { key: "C", is_key: false, count: 3, upper_count: 1, lower_count: 1 },
    ],
  }
  const analyzed = analyzeItem(good, { n_group: 27 })
  assert.equal(analyzed.grade, "A")
  assert.equal(analyzed.r_label, "好")
  const summary = summarizeQuality([good, bad], { n_group: 27 })
  assert.equal(summary.items.length, 2)
  assert.equal(summary.counts.A + summary.counts.B + summary.counts.C + summary.counts.D, 2)
  assert.ok(summary.flagged >= 1)
  assert.ok(summary.average != null)
})

ok("百分比文案", () => {
  assert.equal(pctText(0.625), "63%")
  assert.equal(pctText(null), "—")
})

console.log(`\n${passed} 项通过`)
