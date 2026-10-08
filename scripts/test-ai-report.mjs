// 跑法：node scripts/test-ai-report.mjs
//
// 只测 lib/ai-report-prompt.js 的拼装与校验。为什么值得钉死：
//   · "不要猜姓名"是**产品口径**（0088 只给"学生N"编号）——提示词里漏掉这句，
//     模型就会写"张同学"，教师会当成真事；
//   · 校验函数是"半截报告不许入库"的唯一一道门，判定反了会把残缺内容存成班级结论。
import assert from "node:assert/strict"
import { SYSTEM_PROMPT, buildAiReportMessages, validateAiReport, arr } from "../lib/ai-report-prompt.js"

let n = 0
const t = (name, fn) => {
  try {
    fn()
    n++
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`)
    process.exitCode = 1
  }
}

// 与服务端 0088 的 payload 同形（截取自线上真实返回，只留一道题）
const PAYLOAD = {
  paper: { title: "24级计算机模拟卷（一）", full_score: 6, question_count: 2 },
  class: { student_count: 27, participants: 6, ungraded: 0 },
  score: { avg_percent: 0.5833, min_percent: 0, max_percent: 1 },
  questions: [
    {
      seq: 1,
      qtype: "single_choice",
      score: 3,
      node: "办公应用",
      stem: "在下列图形的控制点中，表示形状控制点的是",
      graded: 6,
      correct: 4,
      correct_rate: 0.6667,
      options: [
        { key: "A", is_answer: false, count: 2, students: ["学生3", "学生5"] },
        { key: "C", is_answer: true, count: 4, students: ["学生1", "学生2"] },
      ],
      wrong: ["学生3", "学生5"],
    },
  ],
}

// ---- 拼消息 ----
t("两条消息，system 在前、且是那份稳定常量（前缀缓存靠它）", () => {
  const m = buildAiReportMessages(PAYLOAD)
  assert.equal(m.length, 2)
  assert.equal(m[0].role, "system")
  assert.equal(m[0].content, SYSTEM_PROMPT)
  assert.equal(m[1].role, "user")
})

t("数据进 user 消息，不进 system（进了 system 就毁掉前缀缓存）", () => {
  const m = buildAiReportMessages(PAYLOAD)
  const userText = JSON.stringify(m[1].content)
  assert.ok(userText.includes("24级计算机模拟卷（一）"))
  assert.ok(!SYSTEM_PROMPT.includes("24级计算机模拟卷"))
})

t("教师没填复习进度：改用 practice（最近 30 天练习）推断教学进度", () => {
  const m = buildAiReportMessages(PAYLOAD, { progressNote: "   " })
  const text = JSON.stringify(m[1].content)
  assert.ok(text.includes("没有填写"))
  assert.ok(text.includes("practice"))
  assert.ok(text.includes("不要假设教师教过练习里没有的内容"))
})

t("教师填了复习进度：原文进 user 消息，并要求 plan 与它对齐", () => {
  const m = buildAiReportMessages(PAYLOAD, { progressNote: "这周复习到 Excel 函数" })
  const text = JSON.stringify(m[1].content)
  assert.ok(text.includes("这周复习到 Excel 函数"))
  assert.ok(text.includes("对齐"))
})

t("提示词里必须有「不要猜姓名」这条口径", () => {
  assert.ok(SYSTEM_PROMPT.includes("不要猜姓名"))
  assert.ok(SYSTEM_PROMPT.includes("学生"))
})

// ---- 校验：模型返回的东西能不能入库 ----
const GOOD = {
  overview: "本次 6 人参加，班均 58%，两极分化明显。",
  strengths: ["基础操作题整体掌握较好"],
  key_points: [{ point: "办公应用", mastery: "一般", evidence: "第 1 题正确率 67%" }],
  weak_points: [{ point: "形状控制点", evidence: "2 人选了 A", suggestion: "用图形演示一遍" }],
  question_notes: [{ seq: 1, note: "干扰项 A 有吸引力" }],
  plan: { consolidate: ["先补形状控制点"], extend: [], improve: [] },
  caveats: "参加人数只有 6 人，样本小。",
}

t("完整报告：通过", () => {
  assert.equal(validateAiReport(GOOD).ok, true)
})

t("没有 overview：拒收（报告的价值就在这段判断）", () => {
  assert.equal(validateAiReport({ ...GOOD, overview: "   " }).ok, false)
})

t("只有知识点、没有 plan：仍然通过（分段缺失不该让整次生成白跑）", () => {
  const r = validateAiReport({ overview: "x", key_points: GOOD.key_points })
  assert.equal(r.ok, true)
})

t("既没有 plan 也没有任何知识点：拒收", () => {
  const r = validateAiReport({ overview: "x", strengths: ["a"] })
  assert.equal(r.ok, false)
})

t("非对象（模型吐了字符串/数组）：拒收而不是崩", () => {
  for (const bad of [null, undefined, "文本", [], 42]) {
    assert.equal(validateAiReport(bad).ok, false, String(bad))
  }
})

t("arr：模型把数组写成字符串或 null 时当空数组", () => {
  assert.deepEqual(arr("x"), [])
  assert.deepEqual(arr(null), [])
  assert.deepEqual(arr([1]), [1])
})

console.log(`ai-report: ${n} 项通过`)
