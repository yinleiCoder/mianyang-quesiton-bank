// AI 错因诊断的提示词、数据合并与校验断言。不调网络、不连库。
// 运行：npm run test:error-diagnosis
import assert from "node:assert/strict"
import {
  ERROR_CODE_LABELS,
  SYSTEM_PROMPT,
  buildErrorDiagnosisMessages,
  pickDiagnosableQuestions,
  validateErrorDiagnosis,
} from "@/lib/error-diagnosis-prompt"

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

const payload = {
  paper: { title: "期中卷", exam_name: "期中考试", subject_label: "数学", full_score: 100 },
  class: { name: "计算机 1 班", student_count: 40 },
  questions: [
    {
      seq: 1,
      qtype: "single_choice",
      difficulty: 2,
      node: "判别式",
      stem: "已知 x²-3x+2=0，判别式的值为（ ）",
      graded: 30,
      correct: 10,
      correct_rate: 0.3333,
      options: [
        { key: "A", is_answer: true, count: 10, students: ["张三"] },
        { key: "B", is_answer: false, count: 20, students: ["李四"] },
      ],
      samples: [],
      fill_texts: [],
    },
    {
      seq: 2,
      qtype: "fill_blank",
      difficulty: 1,
      node: "一元二次方程",
      stem: "方程 x²-3x+2=0 的较小根是 ______",
      graded: 20,
      correct: 5,
      correct_rate: 0.25,
      options: [],
      fill_texts: [{ text: "-1", count: 15, students: ["王五"] }],
      samples: [],
    },
    {
      seq: 3,
      qtype: "single_choice",
      difficulty: 1,
      node: "函数",
      stem: "样本不足的题",
      graded: 3,
      correct: 1,
      correct_rate: 0.3333,
      options: [{ key: "A", is_answer: true, count: 1 }],
      samples: [],
      fill_texts: [],
    },
  ],
}

const stats = {
  items: [
    {
      seq: 1,
      graded: 30,
      correct: 10,
      correct_rate: 0.3333,
      options: [
        { key: "A", text: "1", is_answer: true, count: 10, students: ["张三"] },
        { key: "B", text: "-1", is_answer: false, count: 20, students: ["李四"] },
      ],
      text_counts: [],
    },
    {
      seq: 2,
      graded: 20,
      correct: 5,
      correct_rate: 0.25,
      options: [],
      text_counts: [{ text: "-1", count: 15 }],
    },
    {
      seq: 3,
      graded: 3,
      correct: 1,
      correct_rate: 0.3333,
      options: [{ key: "A", text: "1", is_answer: true, count: 1 }],
      text_counts: [],
    },
  ],
}

ok("system 提示词稳定且包含固定分类", () => {
  assert.ok(SYSTEM_PROMPT.includes("concept_confusion"))
  assert.ok(SYSTEM_PROMPT.includes("不出现学生姓名"))
  assert.ok(SYSTEM_PROMPT.includes("evidence"))
})

ok("合并数据：只留样本 ≥5 且有文本的题，按正确率升序", () => {
  const picked = pickDiagnosableQuestions(payload, stats)
  assert.equal(picked.length, 2)
  assert.deepEqual(picked.map((question) => question.seq), [2, 1])
  assert.ok(picked[0].fill_texts.some((item) => item.text === "-1"))
  assert.ok(picked[1].options.some((option) => option.text === "-1"))
})

ok("合并不带学生姓名", () => {
  const picked = pickDiagnosableQuestions(payload, stats)
  const text = JSON.stringify(picked)
  assert.ok(!text.includes("张三"))
  assert.ok(!text.includes("李四"))
  assert.ok(!text.includes("王五"))
})

ok("没有选项文本/填空文本的题被跳过", () => {
  const picked = pickDiagnosableQuestions(
    { questions: [{ seq: 9, qtype: "short_answer", stem: "主观题", graded: 20, correct: 5, correct_rate: 0.25 }] },
    { items: [] }
  )
  assert.equal(picked.length, 0)
})

ok("messages：带题干/选项文本/填空文本，不带姓名", () => {
  const picked = pickDiagnosableQuestions(payload, stats)
  const messages = buildErrorDiagnosisMessages({
    paper: payload.paper,
    classInfo: payload.class,
    questions: picked,
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  const user = messages[1].content
  assert.ok(user.includes("判别式"))
  assert.ok(user.includes("-1"))
  assert.ok(!user.includes("张三"))
})

ok("合法诊断：通过", () => {
  const picked = pickDiagnosableQuestions(payload, stats)
  const check = validateErrorDiagnosis(
    {
      questions: [
        {
          seq: 1,
          causes: [
            { code: "concept_confusion", share: 0.6, evidence: "-1", remedy: "对比判别式与根" },
            { code: "calculation", share: 0.4, evidence: "1", remedy: "重算 Δ" },
          ],
          teaching_move: "先讲 B 选项",
          caveats: "样本 30 人",
        },
        {
          seq: 2,
          causes: [{ code: "calculation", share: 1, evidence: "-1", remedy: "代入验算" }],
          teaching_move: "做一道变式",
        },
      ],
      summary: "集中在判别式",
      caveats: "",
    },
    { questions: picked }
  )
  assert.equal(check.ok, true)
  assert.equal(check.diagnosis.questions.length, 2)
  assert.equal(check.diagnosis.questions[0].causes[0].code, "concept_confusion")
})

ok("evidence 带引号/前缀也能核到原文（真实模型常见写法）", () => {
  const picked = pickDiagnosableQuestions(payload, stats)
  const check = validateErrorDiagnosis(
    {
      questions: [
        {
          seq: 1,
          causes: [
            {
              code: "calculation",
              share: 0.6,
              evidence: "选项“-1”，20 人",
              remedy: "重算 Δ",
            },
            {
              code: "concept_confusion",
              share: 0.4,
              evidence: "题干“判别式的值为（ ）”",
              remedy: "对比公式顺序",
            },
          ],
        },
      ],
    },
    { questions: picked }
  )
  assert.equal(check.ok, true)
  assert.equal(check.diagnosis.questions[0].causes.length, 2)
})

ok("引号里的假证据仍被拒", () => {
  const picked = pickDiagnosableQuestions(payload, stats)
  const check = validateErrorDiagnosis(
    {
      questions: [
        {
          seq: 1,
          causes: [
            { code: "calculation", share: 1, evidence: "选项“-999”，20 人", remedy: "x" },
          ],
        },
      ],
    },
    { questions: picked }
  )
  assert.equal(check.ok, false)
})

ok("全角/半角括号差异也能核到", () => {
  const picked = pickDiagnosableQuestions(payload, stats)
  const check = validateErrorDiagnosis(
    {
      questions: [
        {
          seq: 1,
          causes: [
            { code: "misreading", share: 1, evidence: "判别式的值为( )", remedy: "x" },
          ],
        },
      ],
    },
    { questions: picked }
  )
  assert.equal(check.ok, true)
})

ok("未知分类/编造证据/不存在题号：被丢弃并警告", () => {
  const picked = pickDiagnosableQuestions(payload, stats)
  const check = validateErrorDiagnosis(
    {
      questions: [
        {
          seq: 1,
          causes: [
            { code: "made_up", share: 0.5, evidence: "-1", remedy: "x" },
            { code: "concept_confusion", share: 0.5, evidence: "编造的证据", remedy: "y" },
          ],
        },
        { seq: 99, causes: [{ code: "other", share: 1, evidence: "x", remedy: "z" }] },
      ],
    },
    { questions: picked }
  )
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("没有可用"))
})

ok("占比合计异常/样本不足：给警告但保留", () => {
  const picked = pickDiagnosableQuestions(payload, stats)
  const check = validateErrorDiagnosis(
    {
      questions: [
        {
          seq: 1,
          causes: [
            { code: "concept_confusion", share: 0.7, evidence: "-1", remedy: "x" },
            { code: "calculation", share: 0.7, evidence: "1", remedy: "y" },
          ],
        },
      ],
    },
    { questions: picked }
  )
  assert.equal(check.ok, true)
  assert.ok(check.warnings.some((w) => w.includes("0.8")))
})

ok("固定分类表有 8 项", () => {
  assert.equal(Object.keys(ERROR_CODE_LABELS).length, 8)
})

ok("非对象 / questions 非数组：拒绝", () => {
  assert.equal(validateErrorDiagnosis(null).ok, false)
  assert.equal(validateErrorDiagnosis({ questions: "x" }).ok, false)
})

console.log(`\n${passed} 项通过`)
