// AI 知识点标签推荐的提示词与校验断言。不调网络、不连库。
// 运行：npm run test:tag-suggest
import assert from "node:assert/strict"
import {
  SYSTEM_PROMPT,
  buildTagSuggestMessages,
  validateTagSuggestion,
} from "@/lib/tag-suggest-prompt"

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

const tags = [
  { id: "t1", name: "一元二次方程", parent_id: null, subject_node_id: "n1" },
  { id: "t2", name: "判别式", parent_id: "t1", subject_node_id: "n1" },
  { id: "t3", name: "函数", parent_id: null, subject_node_id: "n1" },
]
const content = {
  stem: [{ t: "text", text: "已知一元二次方程 x²-3x+2=0，求判别式。" }],
  options: [
    { key: "A", label: [{ t: "text", text: "1" }] },
    { key: "B", label: [{ t: "text", text: "-1" }] },
  ],
  answer: { type: "choice", keys: ["A"] },
  analysis: [{ t: "text", text: "判别式 Δ=b²-4ac=9-8=1。" }],
}

ok("system 提示词稳定且包含关键约束", () => {
  assert.ok(SYSTEM_PROMPT.includes("allowed_tags"))
  assert.ok(SYSTEM_PROMPT.includes("selected_tag_ids"))
  assert.ok(SYSTEM_PROMPT.includes("最多 5 个"))
})

ok("messages：system 稳定，user 带题干/候选标签/已选标签", () => {
  const messages = buildTagSuggestMessages({
    qtype: "single_choice",
    content,
    tags,
    selectedTagIds: ["t3"],
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  const user = messages[1].content
  assert.ok(user.includes("判别式"))
  assert.ok(user.includes("一元二次方程"))
  assert.ok(user.includes("t3"))
  assert.ok(user.includes("已知一元二次方程"))
})

ok("合法建议：通过并按置信度降序", () => {
  const check = validateTagSuggestion(
    {
      tags: [
        { tag_id: "t1", confidence: 0.6, reason: "题干是一元二次方程" },
        { tag_id: "t2", confidence: 0.9, reason: "求判别式" },
      ],
      caveats: "",
    },
    { allowedTags: tags, selectedTagIds: [] }
  )
  assert.equal(check.ok, true)
  assert.deepEqual(check.suggestion.tags.map((t) => t.tag_id), ["t2", "t1"])
})

ok("未知标签：丢弃并警告", () => {
  const check = validateTagSuggestion(
    { tags: [{ tag_id: "tX", confidence: 0.9, reason: "编的" }] },
    { allowedTags: tags }
  )
  assert.equal(check.ok, true)
  assert.equal(check.suggestion.tags.length, 0)
  assert.ok(check.warnings.some((w) => w.includes("范围")))
})

ok("已选标签：丢弃并警告", () => {
  const check = validateTagSuggestion(
    { tags: [{ tag_id: "t1", confidence: 0.9, reason: "已选" }] },
    { allowedTags: tags, selectedTagIds: ["t1"] }
  )
  assert.equal(check.ok, true)
  assert.equal(check.suggestion.tags.length, 0)
  assert.ok(check.warnings.some((w) => w.includes("已经选过")))
})

ok("重复标签：只保留一次", () => {
  const check = validateTagSuggestion(
    {
      tags: [
        { tag_id: "t1", confidence: 0.6, reason: "第一次" },
        { tag_id: "t1", confidence: 0.9, reason: "第二次" },
      ],
    },
    { allowedTags: tags }
  )
  assert.equal(check.ok, true)
  assert.equal(check.suggestion.tags.length, 1)
})

ok("没有理由：丢弃并警告", () => {
  const check = validateTagSuggestion(
    { tags: [{ tag_id: "t1", confidence: 0.9, reason: "" }] },
    { allowedTags: tags }
  )
  assert.equal(check.ok, true)
  assert.equal(check.suggestion.tags.length, 0)
  assert.ok(check.warnings.some((w) => w.includes("理由")))
})

ok("置信度夹到 0–1", () => {
  const high = validateTagSuggestion(
    { tags: [{ tag_id: "t1", confidence: 9, reason: "高" }] },
    { allowedTags: tags }
  )
  assert.equal(high.suggestion.tags[0].confidence, 1)
  const low = validateTagSuggestion(
    { tags: [{ tag_id: "t1", confidence: -2, reason: "低" }] },
    { allowedTags: tags }
  )
  assert.equal(low.suggestion.tags[0].confidence, 0)
})

ok("超过 5 个：按置信度截断并警告", () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    id: `x${index}`,
    name: `标签${index}`,
    parent_id: null,
    subject_node_id: "n1",
  }))
  const check = validateTagSuggestion(
    {
      tags: many.map((tag, index) => ({
        tag_id: tag.id,
        confidence: index / 10,
        reason: "理由",
      })),
    },
    { allowedTags: many }
  )
  assert.equal(check.ok, true)
  assert.equal(check.suggestion.tags.length, 5)
  assert.ok(check.warnings.some((w) => w.includes("5")))
})

ok("空建议：合法", () => {
  const check = validateTagSuggestion({ tags: [], caveats: "题干太短" }, { allowedTags: tags })
  assert.equal(check.ok, true)
  assert.equal(check.suggestion.tags.length, 0)
  assert.equal(check.suggestion.caveats, "题干太短")
})

ok("非对象 / tags 不是数组：拒绝", () => {
  assert.equal(validateTagSuggestion(null, { allowedTags: tags }).ok, false)
  assert.equal(validateTagSuggestion({ tags: "x" }, { allowedTags: tags }).ok, false)
})

console.log(`\n${passed} 项通过`)
