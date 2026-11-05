// 一句话组卷的提示词与校验断言。不调网络、不连库。
// 运行：npm run test:paper-intent
import assert from "node:assert/strict"
import {
  SYSTEM_PROMPT,
  buildPaperIntentMessages,
  intentToRows,
  validatePaperIntent,
} from "@/lib/paper-intent-prompt"
import { QTYPES } from "@/lib/question-model"

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

const allowedNodeIds = ["n1"]
const allowedTags = [
  { id: "t1", name: "一元二次方程", parent_id: null, subject_node_id: "n1" },
  { id: "t2", name: "判别式", parent_id: "t1", subject_node_id: "n1" },
]
const allowedQtypes = QTYPES.map((qtype) => qtype.value)
const options = { allowedNodeIds, allowedTags, allowedQtypes }

function valid(overrides = {}) {
  return {
    target_score: 90,
    exclude_recent_days: 30,
    node_id: "n1",
    requested_tag_ids: ["t1"],
    sections: [
      {
        title: "单项选择题",
        qtype: "single_choice",
        count: 10,
        score_mode: "per_item",
        score_each: 3,
        difficulty_mix: { easy: 0.6, medium: 0.3, hard: 0.1 },
        max_per_tag: 3,
      },
    ],
    assumptions: ["按期中范围理解为第三章及之前"],
    clarify: null,
    ...overrides,
  }
}

ok("system 提示词稳定且包含关键约束", () => {
  assert.ok(SYSTEM_PROMPT.includes("clarify"))
  assert.ok(SYSTEM_PROMPT.includes("allowed_qtypes"))
  assert.ok(SYSTEM_PROMPT.includes("不选题"))
  assert.ok(SYSTEM_PROMPT.includes("difficulty_mix"))
})

ok("messages：system 稳定，user 带原话/题型/标签/科目", () => {
  const messages = buildPaperIntentMessages({
    text: "出一份 90 分的期中卷，第三章为主",
    node: { id: "n1", name: "数学" },
    nodes: [{ id: "n1", name: "数学", parent_id: null }],
    tags: allowedTags,
    currentTarget: 90,
    currentSections: [{ title: "单选题", qtype: "single_choice", count: 10 }],
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  const user = messages[1].content
  assert.ok(user.includes("出一份 90 分的期中卷"))
  assert.ok(user.includes("single_choice"))
  assert.ok(user.includes("一元二次方程"))
  assert.ok(user.includes("数学"))
  assert.ok(user.includes("单选题"))
})

ok("合法意图：通过，并过滤未知标签", () => {
  const result = validatePaperIntent(
    valid({ requested_tag_ids: ["t1", "tX", "t1"] }),
    options
  )
  assert.equal(result.ok, true)
  assert.equal(result.intent.sections.length, 1)
  assert.equal(result.intent.target_score, 90)
  assert.equal(result.intent.exclude_recent_days, 30)
  assert.deepEqual(result.intent.requested_tag_ids, ["t1"])
  assert.ok(result.warnings.some((w) => w.includes("标签")))
})

ok("未知题型：拒绝", () => {
  const result = validatePaperIntent(
    valid({ sections: [{ ...valid().sections[0], qtype: "essay" }] }),
    options
  )
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes("题型"))
})

ok("中文题型名也能归一", () => {
  const result = validatePaperIntent(
    valid({ sections: [{ ...valid().sections[0], qtype: "单选题" }] }),
    options
  )
  assert.equal(result.ok, true)
  assert.equal(result.intent.sections[0].qtype, "single_choice")
})

ok("题数越界：拒绝", () => {
  for (const count of [0, 51]) {
    const result = validatePaperIntent(
      valid({ sections: [{ ...valid().sections[0], count }] }),
      options
    )
    assert.equal(result.ok, false)
  }
})

ok("分值越界：拒绝", () => {
  const result = validatePaperIntent(
    valid({ sections: [{ ...valid().sections[0], score_each: 0 }] }),
    options
  )
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes("分值"))
})

ok("难度配比合计不为 1：拒绝", () => {
  const result = validatePaperIntent(
    valid({
      sections: [
        {
          ...valid().sections[0],
          difficulty_mix: { easy: 0.5, medium: 0.5, hard: 0.5 },
        },
      ],
    }),
    options
  )
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes("难度"))
})

ok("数字键 1/2/3 的难度配比也能接受", () => {
  const result = validatePaperIntent(
    valid({
      sections: [
        {
          ...valid().sections[0],
          difficulty_mix: { 1: 0.3, 2: 0.5, 3: 0.2 },
        },
      ],
    }),
    options
  )
  assert.equal(result.ok, true)
  assert.equal(result.intent.sections[0].difficulty_mix.easy, 0.3)
})

ok("科目不在当前卷面：置 null + 警告", () => {
  const result = validatePaperIntent(valid({ node_id: "n2" }), options)
  assert.equal(result.ok, true)
  assert.equal(result.intent.node_id, null)
  assert.ok(result.warnings.some((w) => w.includes("科目")))
})

ok("信息不足：返回 clarify，不报错", () => {
  const result = validatePaperIntent(
    { clarify: "请补充科目和目标分", sections: [], assumptions: [] },
    options
  )
  assert.equal(result.ok, true)
  assert.equal(result.intent.sections.length, 0)
  assert.equal(result.intent.clarify, "请补充科目和目标分")
})

ok("既没有 sections 也没有 clarify：拒绝", () => {
  const result = validatePaperIntent({ sections: [], clarify: null }, options)
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes("大题"))
})

ok("超过 8 个大题：拒绝", () => {
  const sections = Array.from({ length: 9 }, () => valid().sections[0])
  const result = validatePaperIntent(valid({ sections }), options)
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes("8"))
})

ok("目标分越界：忽略并警告", () => {
  const low = validatePaperIntent(valid({ target_score: 5 }), options)
  assert.equal(low.ok, true)
  assert.equal(low.intent.target_score, null)
  assert.ok(low.warnings.some((w) => w.includes("目标分")))

  const high = validatePaperIntent(valid({ target_score: 200 }), options)
  assert.equal(high.ok, true)
  assert.equal(high.intent.target_score, 200)
  assert.ok(high.warnings.some((w) => w.includes("目标分")))
})

ok("标签最多 8 个", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `t${index + 1}`,
    name: `标签${index + 1}`,
    parent_id: null,
    subject_node_id: "n1",
  }))
  const result = validatePaperIntent(
    valid({ requested_tag_ids: many.map((tag) => tag.id) }),
    { ...options, allowedTags: many }
  )
  assert.equal(result.ok, true)
  assert.equal(result.intent.requested_tag_ids.length, 8)
})

ok("intentToRows：mix 转百分比且合计 100、默认标题", () => {
  const rows = intentToRows({
    sections: [
      {
        qtype: "single_choice",
        count: 10,
        score_mode: "per_item",
        score_each: 3,
        difficulty_mix: { easy: 1 / 3, medium: 1 / 3, hard: 1 / 3 },
      },
    ],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, "单选题")
  assert.equal(rows[0].mix[1] + rows[0].mix[2] + rows[0].mix[3], 100)
})

ok("clarify 为“无”时视为空", () => {
  const result = validatePaperIntent(valid({ clarify: "无" }), options)
  assert.equal(result.ok, true)
  assert.equal(result.intent.clarify, "")
})

console.log(`\n${passed} 项通过`)
