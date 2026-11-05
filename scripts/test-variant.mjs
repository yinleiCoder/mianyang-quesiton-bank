// AI 变式题的提示词、返回校验与 normalizeQuestion 衔接断言。不调网络。
// 运行：npm run test:variant
import assert from "node:assert/strict"
import {
  SYSTEM_PROMPT,
  buildVariantMessages,
  isVariantableQtype,
  validateVariantResponse,
} from "@/lib/variant-prompt"
import { draftIssues, normalizeQuestion } from "@/lib/import-pipeline"

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

const source = {
  qtype: "single_choice",
  difficulty: 2,
  content: {
    stem: [{ t: "text", text: "已知 x²-3x+2=0，判别式的值为（ ）" }],
    options: [
      { key: "A", label: [{ t: "text", text: "1" }] },
      { key: "B", label: [{ t: "text", text: "-1" }] },
      { key: "C", label: [{ t: "text", text: "5" }] },
      { key: "D", label: [{ t: "text", text: "-5" }] },
    ],
    answer: { type: "choice", keys: ["A"] },
    analysis: [{ t: "text", text: "Δ=9-8=1。" }],
  },
}

ok("system 提示词稳定且包含硬约束", () => {
  assert.ok(SYSTEM_PROMPT.includes("最多 3 道"))
  assert.ok(SYSTEM_PROMPT.includes("qtype 必须与原题相同"))
  assert.ok(SYSTEM_PROMPT.includes("不要生成主观题或复合题"))
})

ok("messages：user 带原题、维度、数量与目标难度", () => {
  const messages = buildVariantMessages({
    qtype: source.qtype,
    difficulty: source.difficulty,
    content: source.content,
    tags: [{ id: "t1", name: "判别式" }],
    dimensions: ["data", "context"],
    count: 2,
    targetDifficulty: 3,
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  const user = messages[1].content
  assert.ok(user.includes("判别式"))
  assert.ok(user.includes("已知 x²-3x+2=0"))
  assert.ok(user.includes("data"))
  assert.ok(user.includes("\"count\": 2"))
  assert.ok(user.includes("target_difficulty"))
})

ok("合法返回：通过", () => {
  const check = validateVariantResponse({
    questions: [
      { qtype: "single_choice", stem: "题 1", options: [], answer: ["A"] },
      { qtype: "single_choice", stem: "题 2", options: [], answer: ["B"] },
    ],
    caveats: "请核对",
  })
  assert.equal(check.ok, true)
  assert.equal(check.questions.length, 2)
  assert.equal(check.caveats, "请核对")
})

ok("超过 3 道：截断并警告", () => {
  const check = validateVariantResponse({
    questions: Array.from({ length: 5 }, () => ({ stem: "题" })),
  })
  assert.equal(check.ok, true)
  assert.equal(check.questions.length, 3)
  assert.ok(check.warnings.some((w) => w.includes("3")))
})

ok("没有题目：拒绝", () => {
  const check = validateVariantResponse({ questions: [] })
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("没有生成"))
})

ok("非对象 / questions 非数组：拒绝", () => {
  assert.equal(validateVariantResponse(null).ok, false)
  assert.equal(validateVariantResponse({ questions: "x" }).ok, false)
})

ok("题型白名单：只有客观题", () => {
  assert.equal(isVariantableQtype("single_choice"), true)
  assert.equal(isVariantableQtype("fill_blank"), true)
  assert.equal(isVariantableQtype("composite"), false)
  assert.equal(isVariantableQtype("short_answer"), false)
})

ok("normalizeQuestion：模型返回能落成可保存的 content", () => {
  const normalized = normalizeQuestion(
    {
      qtype: "single_choice",
      difficulty: "medium",
      stem: "若 x²-5x+6=0，判别式的值为（ ）",
      options: [
        { key: "A", text: "1" },
        { key: "B", text: "-1" },
        { key: "C", text: "5" },
        { key: "D", text: "-5" },
      ],
      answer: ["A"],
      analysis: "Δ=25-24=1。",
      variant_note: "只改了系数",
    },
    { defaultQtype: "single_choice", defaultDifficulty: 2, genAnalysis: true }
  )
  assert.ok(normalized)
  assert.equal(normalized.qtype, "single_choice")
  assert.equal(normalized.difficulty, 2)
  assert.equal(draftIssues(normalized.qtype, normalized.content).length, 0)
  assert.ok(normalized.content.options.length === 4)
})

ok("normalizeQuestion：缺答案会被规则检查抓住", () => {
  const normalized = normalizeQuestion(
    {
      qtype: "single_choice",
      stem: "若 x²-5x+6=0，判别式的值为（ ）",
      options: [
        { key: "A", text: "1" },
        { key: "B", text: "-1" },
      ],
    },
    { defaultQtype: "single_choice", defaultDifficulty: 2 }
  )
  assert.ok(normalized)
  assert.ok(normalized.issues.length > 0)
  assert.ok(normalized.flags.includes("answer_missing"))
})

console.log(`\n${passed} 项通过`)
