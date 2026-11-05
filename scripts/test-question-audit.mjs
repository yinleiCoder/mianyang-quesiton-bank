// 审题规则引擎断言。不连库、不调模型。
// 运行：npm run test:audit
import assert from "node:assert/strict"
import { auditQuestion } from "@/lib/question-audit"

const text = (value) => [{ t: "text", text: value }]

const goodChoice = {
  stem: text("下列关于计算机病毒的说法，正确的是"),
  options: [
    { key: "A", label: text("病毒是一段具有破坏性的程序") },
    { key: "B", label: text("病毒只能通过 U 盘传播") },
    { key: "C", label: text("病毒不会影响系统运行") },
    { key: "D", label: text("病毒是硬件故障") },
  ],
  answer: { type: "choice", keys: ["A"] },
  analysis: text("病毒是一段程序，A 正确；B、C、D 均不符合定义。"),
}

const base = {
  qtype: "single_choice",
  difficulty: 2,
  tags: ["计算机"],
  hasNode: true,
}

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

ok("结构完整的题：通过且 A", () => {
  const result = auditQuestion({ ...base, content: goodChoice })
  assert.equal(result.verdict, "pass")
  assert.equal(result.grade, "A")
  assert.equal(result.stats.errors, 0)
  assert.equal(result.stats.warnings, 0)
})

ok("答案键不在选项：critical + reject", () => {
  const content = { ...goodChoice, answer: { type: "choice", keys: ["Z"] } }
  const result = auditQuestion({ ...base, content })
  assert.equal(result.verdict, "reject")
  assert.ok(result.issues.some((item) => item.code === "answer_not_in_options" && item.critical))
})

ok("选项重复：critical + reject", () => {
  const content = {
    ...goodChoice,
    options: [
      goodChoice.options[0],
      goodChoice.options[1],
      goodChoice.options[2],
      { key: "D", label: text("病毒是一段具有破坏性的程序") },
    ],
  }
  const result = auditQuestion({ ...base, content })
  assert.equal(result.verdict, "reject")
  assert.ok(result.issues.some((item) => item.code === "duplicate_options"))
})

ok("填空题空位与答案数不一致：error", () => {
  const content = {
    stem: text("二进制 1010 的十进制是 ______，十六进制是 ______"),
    answer: { type: "blank", values: ["10"] },
    analysis: text("按权展开。"),
  }
  const result = auditQuestion({ qtype: "fill_blank", difficulty: 2, content, tags: ["计算机"], hasNode: true })
  assert.equal(result.verdict, "revise")
  assert.ok(result.issues.some((item) => item.problem.includes("空位")))
})

ok("缺解析：error", () => {
  const content = { ...goodChoice, analysis: [] }
  const result = auditQuestion({ ...base, content })
  assert.equal(result.verdict, "revise")
  assert.ok(result.issues.some((item) => item.problem.includes("解析")))
})

ok("高度相似：warn", () => {
  const result = auditQuestion({
    ...base,
    content: goodChoice,
    similar: [{ similarity: 0.86, stem: "关于计算机病毒的正确说法是" }],
  })
  assert.ok(result.issues.some((item) => item.code === "similar_high" && item.severity === "warn"))
})

ok("实测偏易：info", () => {
  const result = auditQuestion({
    ...base,
    content: goodChoice,
    accuracy: { attempts: 100, correct: 99 },
  })
  assert.ok(result.issues.some((item) => item.problem.includes("偏易")))
})

ok("未打标签：warn", () => {
  const result = auditQuestion({ ...base, content: goodChoice, tags: [] })
  assert.ok(result.issues.some((item) => item.category === "标签" && item.severity === "warn"))
})

ok("以上都不对：warn", () => {
  const content = {
    ...goodChoice,
    options: [
      goodChoice.options[0],
      { key: "B", label: text("以上都不对") },
    ],
  }
  const result = auditQuestion({ ...base, content })
  assert.ok(result.issues.some((item) => item.problem.includes("以上都")))
})

ok("评分在 0~100 且按严重度排序", () => {
  const content = { ...goodChoice, answer: { type: "choice", keys: ["Z"] }, analysis: [] }
  const result = auditQuestion({ ...base, content })
  assert.ok(result.score >= 0 && result.score <= 100)
  assert.equal(result.issues[0].severity, "error")
})

console.log(`\n${passed} 项通过`)
