// AI 复审提示词与返回校验的断言。不调网络。
// 运行：node --import ./scripts/alias-loader.mjs scripts/test-question-audit-prompt.mjs
import assert from "node:assert/strict"
import {
  SYSTEM_PROMPT,
  buildQuestionAuditMessages,
  validateQuestionAudit,
} from "@/lib/question-audit-prompt"

const text = (value) => [{ t: "text", text: value }]

const content = {
  stem: text("下列关于计算机病毒的说法，正确的是"),
  options: [
    { key: "A", label: text("病毒是一段具有破坏性的程序") },
    { key: "B", label: text("病毒只能通过 U 盘传播") },
  ],
  answer: { type: "choice", keys: ["A"] },
  analysis: text("病毒是一段程序。"),
}

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

ok("system 提示词逐字节稳定，且不含动态数据", () => {
  const messages = buildQuestionAuditMessages({
    qtype: "single_choice",
    difficulty: 2,
    content,
    tags: ["计算机"],
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, "system")
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  assert.ok(SYSTEM_PROMPT.includes("只输出"))
  assert.ok(SYSTEM_PROMPT.includes("json"))
  assert.ok(SYSTEM_PROMPT.includes("不发送、不猜测学生姓名"))
})

ok("user 消息带题目与经验数据，不带姓名", () => {
  const messages = buildQuestionAuditMessages({
    qtype: "single_choice",
    difficulty: 2,
    content,
    tags: ["计算机"],
    accuracy: { attempts: 30, correct: 27 },
    similar: [{ similarity: 0.72, stem: "相似题" }],
  })
  const user = messages[1].content
  assert.ok(user.includes("计算机病毒"))
  assert.ok(user.includes('"attempts": 30'))
  assert.ok(user.includes('"similarity": 0.72'))
  assert.ok(!user.includes("张三"))
})

ok("合法返回通过校验", () => {
  const check = validateQuestionAudit({
    score: 82,
    verdict: "revise",
    issues: [
      {
        severity: "warn",
        category: "科学性",
        evidence: "以上都不对",
        problem: "选项含“以上都不对”",
        suggestion: "改成具体选项",
      },
    ],
    rewrite_hint: "补全干扰项",
    caveats: "样本少",
  })
  assert.equal(check.ok, true)
  assert.equal(check.audit.score, 82)
  assert.equal(check.audit.issues.length, 1)
})

ok("非法返回被拒", () => {
  assert.equal(validateQuestionAudit(null).ok, false)
  assert.equal(validateQuestionAudit([]).ok, false)
  assert.equal(validateQuestionAudit({ score: 120, issues: [] }).ok, false)
  assert.equal(validateQuestionAudit({ score: 80, issues: "x" }).ok, false)
})

ok("未知 severity 降级为 info，缺 problem 的条目丢弃", () => {
  const check = validateQuestionAudit({
    score: 70,
    verdict: "unknown",
    issues: [
      { severity: "fatal", category: "科学性", problem: "有问题", suggestion: "改" },
      { severity: "warn", category: "规范性" },
    ],
  })
  assert.equal(check.ok, true)
  assert.equal(check.audit.verdict, "revise")
  assert.equal(check.audit.issues.length, 1)
  assert.equal(check.audit.issues[0].severity, "info")
})

console.log(`\n${passed} 项通过`)
