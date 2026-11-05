// 智能组卷纯函数断言。不连库、不调模型。
// 运行：npm run test:paper-ai
import assert from "node:assert/strict"
import {
  optimizePaperPlan,
  itemScoreForCandidate,
  sectionTargetBands,
  swapPlanItem,
} from "@/lib/paper-optimizer"
import { expandUnits, sumUnits } from "@/lib/paper-units"
import {
  effectiveDifficultyBand,
  exposurePenalty,
  shrunkDifficulty,
} from "@/lib/item-stats"

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

const fillContent = {
  stem: [{ t: "text", text: "甲 ______ 乙 ______ 丙 ______" }],
  options: [],
  sub: [],
}
const compositeContent = {
  stem: [{ t: "text", text: "阅读材料" }],
  sub: [
    { type: "fill_blank", stem: [{ t: "text", text: "子题一 ______ 子题二 ______" }] },
    { type: "single_choice", stem: [{ t: "text", text: "子题三" }] },
  ],
}

ok("per_blank 填空分值 = expandUnits", () => {
  const section = { score_mode: "per_blank", score_each: 2 }
  const candidate = { qtype: "fill_blank", blank_count: 3 }
  const expected = sumUnits(
    expandUnits({ mode: "per_blank", qtype: "fill_blank", content: fillContent, scoreEach: 2, custom: null })
  )
  assert.equal(itemScoreForCandidate(section, candidate), expected)
})

ok("per_sub 复合分值 = expandUnits", () => {
  const section = { score_mode: "per_sub", score_each: 4 }
  const candidate = {
    qtype: "composite",
    subs: [{ type: "fill_blank", blank_count: 2 }, { type: "single_choice", blank_count: 0 }],
  }
  const expected = sumUnits(
    expandUnits({ mode: "per_sub", qtype: "composite", content: compositeContent, scoreEach: 4, custom: null })
  )
  assert.equal(itemScoreForCandidate(section, candidate), expected)
})

ok("per_blank 复合分值 = expandUnits", () => {
  const section = { score_mode: "per_blank", score_each: 4 }
  const candidate = {
    qtype: "composite",
    subs: [{ type: "fill_blank", blank_count: 2 }, { type: "single_choice", blank_count: 0 }],
  }
  const expected = sumUnits(
    expandUnits({ mode: "per_blank", qtype: "composite", content: compositeContent, scoreEach: 4, custom: null })
  )
  assert.equal(itemScoreForCandidate(section, candidate), expected)
})

ok("难度槽位按配比分配", () => {
  const bands = sectionTargetBands({ count: 10, difficulty_mix: { 1: 0.3, 2: 0.5, 3: 0.2 } })
  assert.equal(bands.length, 10)
  assert.equal(bands.filter((b) => b === 1).length, 3)
  assert.equal(bands.filter((b) => b === 2).length, 5)
  assert.equal(bands.filter((b) => b === 3).length, 2)
})

let seq = 0
function makeCandidate(overrides = {}) {
  seq += 1
  return {
    question_id: `q${seq}`,
    version_id: `v${seq}`,
    qtype: "single_choice",
    difficulty: 2,
    node_id: "n1",
    node_name: "办公应用",
    tag_ids: ["t1"],
    tag_names: ["excel"],
    attempts: 20,
    correct: 10,
    uses_90d: 0,
    stem_text: `题干 ${seq} 的内容`,
    blank_count: 0,
    option_count: 4,
    subs: [],
    ...overrides,
  }
}

const pool = []
for (let i = 0; i < 30; i++) {
  pool.push(
    makeCandidate({
      qtype: "single_choice",
      difficulty: 1 + (i % 3),
      tag_ids: [["t1", "t2", "t3"][i % 3]],
      correct: 5 + ((i * 3) % 15),
      uses_90d: i % 4,
    })
  )
}
for (let i = 0; i < 30; i++) {
  pool.push(
    makeCandidate({
      qtype: "fill_blank",
      difficulty: 1 + (i % 3),
      tag_ids: [["t1", "t2", "t3"][i % 3]],
      correct: 5 + ((i * 3) % 15),
      uses_90d: i % 4,
      blank_count: 3,
    })
  )
}

const spec = {
  sections: [
    {
      key: "s1",
      title: "单项选择题",
      qtype: "single_choice",
      count: 10,
      score_mode: "per_item",
      score_each: 2,
      difficulty_mix: { 1: 0.3, 2: 0.5, 3: 0.2 },
    },
    {
      key: "s2",
      title: "填空题",
      qtype: "fill_blank",
      count: 5,
      score_mode: "per_blank",
      score_each: 2,
      difficulty_mix: { 1: 0.2, 2: 0.6, 3: 0.2 },
    },
  ],
  target_score: 50,
  requested_tag_ids: ["t1", "t2", "t3"],
  exclude_recent_days: 90,
}

const plan = optimizePaperPlan(spec, pool, { seed: 42, iterations: 500 })

ok("方案可行且题量正确", () => {
  assert.equal(plan.feasible, true)
  assert.equal(plan.sections[0].items.length, 10)
  assert.equal(plan.sections[1].items.length, 5)
})

ok("题目唯一", () => {
  const ids = plan.sections.flatMap((s) => s.items.map((i) => i.question_id))
  assert.equal(new Set(ids).size, ids.length)
})

ok("总分等于目标", () => {
  assert.equal(plan.metrics.total_score, 50)
})

ok("同 seed 结果一致", () => {
  const again = optimizePaperPlan(spec, pool, { seed: 42, iterations: 500 })
  const a = plan.sections.flatMap((s) => s.items.map((i) => i.question_id))
  const b = again.sections.flatMap((s) => s.items.map((i) => i.question_id))
  assert.deepEqual(a, b)
})

ok("题量不足返回不可行", () => {
  const bad = { ...spec, sections: [{ ...spec.sections[0], count: 999 }] }
  const result = optimizePaperPlan(bad, pool, { seed: 1, iterations: 10 })
  assert.equal(result.feasible, false)
  assert.ok(result.warnings.length > 0)
})

ok("曝光惩罚单调且有上界", () => {
  assert.equal(exposurePenalty(0), 0)
  assert.equal(exposurePenalty(3), 1)
  assert.equal(exposurePenalty(10), 1)
})

ok("同等条件下优先少用过的题", () => {
  const fresh = makeCandidate({ question_id: "fresh", uses_90d: 0, stem_text: "同一道题", tag_ids: ["t1"] })
  const used = makeCandidate({ question_id: "used", uses_90d: 3, stem_text: "同一道题", tag_ids: ["t1"] })
  const one = {
    sections: [
      {
        key: "s",
        title: "单选",
        qtype: "single_choice",
        count: 1,
        score_mode: "per_item",
        score_each: 2,
        difficulty_mix: { 2: 1 },
      },
    ],
    target_score: 2,
    requested_tag_ids: [],
  }
  const result = optimizePaperPlan(one, [used, fresh], { mode: "greedy", seed: 7 })
  assert.equal(result.sections[0].items[0].question_id, "fresh")
})

ok("换一题保持题量与唯一性", () => {
  const swapped = swapPlanItem(plan, 0, 0, spec, pool, { seed: 9 })
  assert.equal(swapped.sections[0].items.length, 10)
  assert.equal(swapped.sections[1].items.length, 5)
  const ids = swapped.sections.flatMap((s) => s.items.map((i) => i.question_id))
  assert.equal(new Set(ids).size, ids.length)
})

ok("样本不足时回落作者难度", () => {
  assert.equal(effectiveDifficultyBand({ attempts: 2, correct: 2, difficulty: 3 }), 3)
  assert.ok(shrunkDifficulty({ attempts: 0, correct: 0, difficulty: 2 }) > 0.5)
})

console.log(`\n${passed} 项通过`)
