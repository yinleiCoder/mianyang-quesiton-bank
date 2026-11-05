// AI 辅助主观题评分的提示词与校验断言。不调网络。
// 运行：npm run test:grading
import assert from "node:assert/strict"
import {
  SYSTEM_PROMPT,
  buildGradingMessages,
  validateGradingSuggestion,
} from "@/lib/grading-prompt"
import { buildUnitSpecs } from "@/lib/grading-units"

const base = {
  stem: "简述计算机病毒的定义与两个特征。",
  referenceAnswers: ["病毒是一段具有破坏性的程序；具有传染性和潜伏性。"],
  analysis: "答出定义、传染性、潜伏性三个要点即可。",
  unitLabels: ["本题"],
  maxUnits: [10],
  totalScore: 10,
  studentAnswer: "病毒是一段程序，会传染。",
}

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

ok("system 提示词稳定，user 带参考答案与学生作答", () => {
  const messages = buildGradingMessages(base)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  assert.ok(SYSTEM_PROMPT.includes("只输出"))
  assert.ok(SYSTEM_PROMPT.includes("空白"))
  assert.ok(messages[1].content.includes("病毒是一段具有破坏性的程序"))
  assert.ok(messages[1].content.includes("会传染"))
  assert.ok(!messages[1].content.includes("张三"))
})

ok("合法建议：通过", () => {
  const check = validateGradingSuggestion(
    {
      units: [{ index: 0, score: 7, max: 10, reason: "答出定义与传染性", evidence: "病毒是一段程序，会传染" }],
      confidence: 0.8,
      comment: "定义正确，补上潜伏性。",
      missing_points: ["潜伏性"],
      caveats: "",
    },
    { maxUnits: [10], totalScore: 10 }
  )
  assert.equal(check.ok, true)
  assert.equal(check.suggestion.units[0].score, 7)
  assert.equal(check.suggestion.confidence, 0.8)
})

ok("分数越界：拒绝", () => {
  const check = validateGradingSuggestion(
    { units: [{ index: 0, score: 11, max: 10 }] },
    { maxUnits: [10], totalScore: 10 }
  )
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("越界"))
})

ok("评分点缺失：拒绝", () => {
  const check = validateGradingSuggestion(
    { units: [] },
    { maxUnits: [10], totalScore: 10 }
  )
  assert.equal(check.ok, false)
})

ok("合计超过满分：拒绝", () => {
  const check = validateGradingSuggestion(
    {
      units: [
        { index: 0, score: 6, max: 6 },
        { index: 1, score: 6, max: 6 },
      ],
    },
    { maxUnits: [6, 6], totalScore: 10 }
  )
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("满分"))
})

ok("空白作答必须 0 分", () => {
  const check = validateGradingSuggestion(
    { units: [{ index: 0, score: 5, max: 10 }] },
    { maxUnits: [10], totalScore: 10, blank: true }
  )
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("空白"))
})

ok("按 index 对齐乱序返回，confidence 夹到 0~1", () => {
  const check = validateGradingSuggestion(
    {
      units: [
        { index: 1, score: 2, max: 3, reason: "第二点" },
        { index: 0, score: 1, max: 2, reason: "第一点" },
      ],
      confidence: 9,
    },
    { maxUnits: [2, 3], totalScore: 5 }
  )
  assert.equal(check.ok, true)
  assert.deepEqual(check.suggestion.units.map((item) => item.score), [1, 2])
  assert.equal(check.suggestion.confidence, 1)
})

ok("填空题拆成逐空 binary specs", () => {
  const item = {
    qtype: "fill_blank",
    score: 4,
    score_units: [2, 2],
    content: {
      stem: [{ t: "text", text: "甲 ______ 乙 ______" }],
      answer: { type: "blank", values: ["A", "B"] },
    },
  }
  const record = { answer: { type: "blank", values: ["A", ""] } }
  const specs = buildUnitSpecs(item, record, ["第一空", "第二空"])
  assert.equal(specs.length, 2)
  assert.equal(specs[0].mode, "binary")
  assert.equal(specs[0].max, 2)
  assert.equal(specs[0].student, "A")
  assert.equal(specs[1].blank, true)
})

ok("综合题按子题/空对齐 score_units", () => {
  const item = {
    qtype: "composite",
    score: 6,
    score_units: [2, 1, 1, 2],
    content: {
      stem: [{ t: "text", text: "材料" }],
      sub: [
        {
          type: "single_choice",
          stem: [{ t: "text", text: "子题一" }],
          options: [
            { key: "A", label: [{ t: "text", text: "甲" }] },
            { key: "B", label: [{ t: "text", text: "乙" }] },
          ],
          answer: { type: "choice", keys: ["A"] },
        },
        {
          type: "fill_blank",
          stem: [{ t: "text", text: "子题二 ______ ______" }],
          answer: { type: "blank", values: ["x", "y"] },
        },
        {
          type: "short_answer",
          stem: [{ t: "text", text: "子题三" }],
          answer: { type: "text", samples: ["要点"] },
        },
      ],
    },
  }
  const record = {
    answer: {
      type: "composite",
      subs: [
        { type: "choice", keys: ["A"] },
        { type: "blank", values: ["x", ""] },
        { type: "text", text: "写了要点" },
      ],
    },
  }
  const specs = buildUnitSpecs(item, record, ["1", "2-1", "2-2", "3"])
  assert.equal(specs.length, 4)
  assert.equal(specs[0].mode, "binary")
  assert.equal(specs[1].mode, "binary")
  assert.equal(specs[2].blank, true)
  assert.equal(specs[3].mode, "partial")
})

// 2026-11-05 线上事故：整题一个计分点的综合题（卷面 20 分一道），
// 既不是"每个子题一个计分点"也不是"每个空一个计分点"，以前直接落到 fallback，
// student 是空串 → AI 判「未作答」→ 建议 0 分。学生明明写了。
const groupItem = {
  qtype: "composite",
  score: 20,
  score_units: [20],
  content: {
    stem: [{ t: "text", text: "根据材料作答。" }],
    sub: [
      {
        type: "multiple_choice",
        stem: [{ t: "text", text: "（1）下列正确的是" }],
        options: [
          { key: "A", label: [{ t: "text", text: "甲" }] },
          { key: "B", label: [{ t: "text", text: "乙" }] },
        ],
        answer: { type: "choice", keys: ["A", "B"] },
      },
      {
        type: "fill_blank",
        stem: [{ t: "text", text: "（2）公式 ______" }],
        answer: { type: "blank", values: ["C2:C43"] },
      },
    ],
  },
}

ok("综合题整题一个计分点：学生的作答必须带给模型", () => {
  const record = {
    answer: {
      type: "composite",
      subs: [
        { type: "choice", keys: ["A", "B"] },
        { type: "blank", values: ["C2:C43"] },
      ],
    },
  }
  const specs = buildUnitSpecs(groupItem, record, ["本题"])
  assert.equal(specs.length, 1)
  assert.equal(specs[0].mode, "partial")
  assert.equal(specs[0].max, 20)
  assert.equal(specs[0].blank, false)
  assert.ok(specs[0].student.includes("A、B"), `学生选择丢了：${specs[0].student}`)
  assert.ok(specs[0].student.includes("C2:C43"), `学生填空丢了：${specs[0].student}`)
  assert.ok(specs[0].reference.some((line) => line.includes("C2:C43")))
})

ok("综合题整题一个计分点：全空才算未作答", () => {
  const specs = buildUnitSpecs(groupItem, { answer: { type: "composite", subs: [] } }, ["本题"])
  assert.equal(specs.length, 1)
  assert.equal(specs[0].student, "")
  assert.equal(specs[0].blank, true)
})

ok("计分点排布对不上时，fallback 也保留学生作答", () => {
  // 3 个子题、2 个计分点：两种对齐都不成立
  const item = {
    qtype: "composite",
    score_units: [10, 10],
    content: {
      stem: [],
      sub: [
        { type: "short_answer", stem: [{ t: "text", text: "一" }], answer: { type: "text", samples: ["甲"] } },
        { type: "short_answer", stem: [{ t: "text", text: "二" }], answer: { type: "text", samples: ["乙"] } },
        { type: "short_answer", stem: [{ t: "text", text: "三" }], answer: { type: "text", samples: ["丙"] } },
      ],
    },
  }
  const record = {
    answer: {
      type: "composite",
      subs: [
        { type: "text", text: "我的第一段" },
        { type: "text", text: "我的第二段" },
        { type: "text", text: "" },
      ],
    },
  }
  const specs = buildUnitSpecs(item, record, ["一", "二"])
  assert.equal(specs.length, 2)
  assert.equal(specs[0].kind, "unknown")
  assert.ok(specs[0].student.includes("我的第一段"))
  assert.equal(specs[0].blank, false)
})

ok("填空题计分点与空数对不上时，fallback 也带学生作答", () => {
  const item = {
    qtype: "fill_blank",
    score_units: [2, 2],
    content: {
      stem: [{ t: "text", text: "甲 ___ 乙 ___ 丙 ___" }],
      answer: { type: "blank", values: ["A", "B", "C"] },
    },
  }
  const record = { answer: { type: "blank", values: ["A", "B", "C"] } }
  const specs = buildUnitSpecs(item, record, ["一", "二"])
  assert.equal(specs.length, 2)
  assert.equal(specs[0].blank, false)
  assert.ok(specs[0].student.includes("A"), specs[0].student)
})

ok("unit specs：binary 半分与空白非零被拒", () => {
  const specs = [
    { index: 0, mode: "binary", max: 2, blank: false },
    { index: 1, mode: "binary", max: 2, blank: true },
  ]
  const half = validateGradingSuggestion(
    { units: [{ index: 0, score: 1, reason: "半对" }] },
    { unitSpecs: specs, maxUnits: [2, 2], totalScore: 4 }
  )
  assert.equal(half.ok, false)
  const blankScored = validateGradingSuggestion(
    { units: [{ index: 0, score: 2, reason: "对" }, { index: 1, score: 1, reason: "空" }] },
    { unitSpecs: specs, maxUnits: [2, 2], totalScore: 4 }
  )
  assert.equal(blankScored.ok, false)
})

console.log(`\n${passed} 项通过`)
