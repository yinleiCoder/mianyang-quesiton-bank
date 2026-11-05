// 讲评教案：模板兜底、提示词与返回校验的断言。不连库、不调模型。
// 运行：npm run test:lesson
import assert from "node:assert/strict"
import { buildFallbackLessonPlan, scaleMinutes } from "@/lib/lesson-plan-fallback"
import {
  SYSTEM_PROMPT,
  buildLessonPlanMessages,
  collectReportSeqs,
  validateLessonPlan,
} from "@/lib/lesson-plan-prompt"

const REPORT = {
  overview: "本次 38 人参加，班均 58%。",
  weak_points: [
    {
      point: "Excel 函数与单元格引用",
      evidence: "第 5、7 题错误率超过 60%",
      suggestion: "用相对/绝对引用对照表讲",
    },
  ],
  error_analysis: [
    { seq: 5, label: "相对引用与绝对引用混淆", evidence: "高分组 3 人选错", suggestion: "现场改 $ 符号" },
    { seq: 7, label: "函数参数顺序记反", evidence: "错误集中在第二个参数", suggestion: "先范围后条件" },
  ],
  question_notes: [{ seq: 5, note: "干扰项 B 是绝对引用" }],
  action_plan: [
    { action: "用 10 分钟做 $ 符号对照练习" },
    { action: "布置 3 道参数改错题" },
  ],
}

const paper = { title: "计算机类试题" }
const classInfo = { name: "3班陶建" }
const summary = { participants: 38 }

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

ok("分钟分配合计精确", () => {
  for (const total of [20, 40, 45, 90]) {
    const minutes = scaleMinutes(total, [5, 10, 15, 8, 5])
    assert.equal(minutes.reduce((a, b) => a + b, 0), total)
  }
})

ok("模板时间线合计等于时长，且关键题来自报告", () => {
  for (const duration of [40, 45]) {
    const plan = buildFallbackLessonPlan({ report: REPORT, paper, classInfo, summary, durationMinutes: duration })
    const total = plan.timeline.reduce((sum, phase) => sum + phase.minutes, 0)
    assert.equal(total, duration)
    assert.deepEqual(plan.key_points.map((item) => item.seq), [5, 7])
    assert.ok(plan.exit_ticket.questions.length > 0)
    assert.equal(plan.meta.source, "template")
  }
})

ok("模板不出现学生姓名", () => {
  const plan = buildFallbackLessonPlan({ report: REPORT, paper, classInfo, summary })
  const text = JSON.stringify(plan)
  assert.ok(!text.includes("张三"))
  assert.ok(!text.includes("李四"))
})

ok("模板能通过教案校验器（用报告题号）", () => {
  const plan = buildFallbackLessonPlan({ report: REPORT, paper, classInfo, summary, durationMinutes: 45 })
  const check = validateLessonPlan(plan, {
    durationMinutes: 45,
    seqs: collectReportSeqs(REPORT),
  })
  assert.equal(check.ok, true)
  assert.deepEqual(check.plan.key_points.map((item) => item.seq), [5, 7])
})

ok("system 提示词稳定，user 消息带报告与时长", () => {
  const messages = buildLessonPlanMessages({
    report: REPORT,
    paper,
    classInfo,
    summary,
    durationMinutes: 45,
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  assert.ok(SYSTEM_PROMPT.includes("只输出"))
  assert.ok(SYSTEM_PROMPT.includes("key_points"))
  assert.ok(messages[1].content.includes("Excel 函数与单元格引用"))
  assert.ok(messages[1].content.includes('"duration_minutes": 45'))
})

ok("模型时间线合计不对：拒绝", () => {
  const plan = buildFallbackLessonPlan({ report: REPORT, paper, classInfo, summary, durationMinutes: 45 })
  plan.timeline = plan.timeline.map((phase) => ({ ...phase, minutes: 1 }))
  const check = validateLessonPlan(plan, { durationMinutes: 45, seqs: [5, 7] })
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("timeline"))
})

ok("模型发明题号：拒绝", () => {
  const plan = buildFallbackLessonPlan({ report: REPORT, paper, classInfo, summary, durationMinutes: 45 })
  plan.key_points = plan.key_points.map((item) => ({ ...item, seq: 99 }))
  const check = validateLessonPlan(plan, { durationMinutes: 45, seqs: [5, 7] })
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("题号"))
})

ok("出口票为空：拒绝", () => {
  const plan = buildFallbackLessonPlan({ report: REPORT, paper, classInfo, summary, durationMinutes: 45 })
  plan.exit_ticket = { questions: [], success_criteria: "" }
  const check = validateLessonPlan(plan, { durationMinutes: 45, seqs: [5, 7] })
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("exit_ticket"))
})

ok("collectReportSeqs 去重", () => {
  assert.deepEqual(collectReportSeqs(REPORT).sort((a, b) => a - b), [5, 7])
})

console.log(`\n${passed} 项通过`)
