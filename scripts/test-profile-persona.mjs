// 学习画像 persona/summary 纯函数断言。不连库、不调模型。
// 运行：npm run test:profile
import assert from "node:assert/strict"
import {
  PERSONAS,
  buildPersona,
  buildSummary,
  composeProfile,
} from "@/lib/profile-persona"

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

const LABELS = {
  mastery: "掌握力",
  accuracy: "准确率",
  effort: "勤奋度",
  growth: "进步力",
  breadth: "知识面",
  stability: "稳定性",
}

function axes(scores) {
  return Object.entries(LABELS).map(([key, label]) => ({
    key,
    label,
    score: scores[key] ?? null,
    sufficient: (scores[key] ?? null) != null,
  }))
}

ok("稳健型：掌握/准确/稳定都在高位", () => {
  const persona = buildPersona(
    axes({ mastery: 78, accuracy: 81, effort: 60, growth: 50, breadth: 50, stability: 74 })
  )
  assert.equal(persona.key, "steady")
  assert.ok(persona.reason.includes("78"))
})

ok("冲刺型：进步与勤奋同时高", () => {
  const persona = buildPersona(
    axes({ mastery: 50, accuracy: 60, effort: 80, growth: 65, breadth: 50, stability: 50 })
  )
  assert.equal(persona.key, "sprinter")
})

ok("探索型：知识面宽但准确率低", () => {
  const persona = buildPersona(
    axes({ mastery: 50, accuracy: 60, effort: 50, growth: 50, breadth: 80, stability: 50 })
  )
  assert.equal(persona.key, "explorer")
})

ok("勤奋型：勤奋高但准确率低", () => {
  const persona = buildPersona(
    axes({ mastery: 50, accuracy: 60, effort: 80, growth: 50, breadth: 50, stability: 50 })
  )
  assert.equal(persona.key, "diligent")
})

ok("均衡型：最高与最低差 ≤15", () => {
  const persona = buildPersona(
    axes({ mastery: 60, accuracy: 62, effort: 58, growth: 61, breadth: 59, stability: 60 })
  )
  assert.equal(persona.key, "balanced")
})

ok("成长型：六轴齐全但没有强标签", () => {
  const persona = buildPersona(
    axes({ mastery: 90, accuracy: 50, effort: 50, growth: 40, breadth: 40, stability: 40 })
  )
  assert.equal(persona.key, "growing")
})

ok("新同学：不足 5 轴有数据", () => {
  const persona = buildPersona(
    axes({ mastery: 80, accuracy: 80, effort: 80, growth: 80, breadth: null, stability: null })
  )
  assert.equal(persona.key, "newcomer")
  assert.ok(persona.reason.includes("还差 1 个维度"))
})

ok("准确率缺失时不会误判成探索型/勤奋型", () => {
  const persona = buildPersona(
    axes({ mastery: 50, accuracy: null, effort: 60, growth: 50, breadth: 80, stability: 50 })
  )
  assert.notEqual(persona.key, "explorer")
  assert.notEqual(persona.key, "diligent")
})

ok("summary 带强项与最该补的轴", () => {
  const list = axes({
    mastery: 90,
    accuracy: 60,
    effort: 30,
    growth: 50,
    breadth: 50,
    stability: 50,
  })
  const summary = buildSummary(list)
  assert.ok(summary.includes("掌握力 90"))
  assert.ok(summary.includes("勤奋度 30"))
})

ok("summary 空数据给引导而不是空话", () => {
  assert.ok(buildSummary([]).includes("再练几题"))
})

ok("composeProfile 加 persona/summary，不改原始字段", () => {
  const raw = {
    student: { user_id: "u1", name: "张三" },
    window_days: 90,
    axes: axes({ mastery: 78, accuracy: 81, effort: 60, growth: 50, breadth: 50, stability: 74 }),
    caveats: ["样本说明"],
  }
  const profile = composeProfile(raw)
  assert.equal(profile.persona.key, "steady")
  assert.ok(profile.summary.includes("掌握力"))
  assert.equal(profile.student.name, "张三")
  assert.deepEqual(profile.caveats, ["样本说明"])
})

ok("PERSONAS 文案齐全", () => {
  for (const key of ["steady", "sprinter", "explorer", "diligent", "balanced", "growing", "newcomer"]) {
    assert.ok(PERSONAS[key])
  }
})

console.log(`\n${passed} 项通过`)
