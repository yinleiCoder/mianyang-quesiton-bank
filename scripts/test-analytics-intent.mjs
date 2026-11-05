// 学情问数的提示词、意图校验与模板摘要断言。不调网络、不连库。
// 运行：npm run test:analytics-intent
import assert from "node:assert/strict"
import {
  SYSTEM_PROMPT,
  buildAnalyticsIntentMessages,
  buildLeaderboardRows,
  buildLeaderboardSummary,
  buildPracticeSummary,
  buildPracticeTrendRows,
  buildQuestionQualityRows,
  buildQuestionQualitySummary,
  buildQuestionStatsRows,
  buildQuestionStatsSummary,
  buildStudentDetailRows,
  buildStudentDetailSummary,
  buildStudentDetailWrongRows,
  buildWeakNodesRows,
  buildWeakNodesSummary,
  validateAnalyticsIntent,
} from "@/lib/analytics-intent"

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log("✓", name)
}

const nodes = [
  {
    id: "n1",
    name: "判别式",
    parent_id: null,
    scope: "common",
    kind: "course",
    sort_order: 0,
    is_frozen: false,
  },
  {
    id: "n2",
    name: "函数",
    parent_id: null,
    scope: "common",
    kind: "course",
    sort_order: 0,
    is_frozen: false,
  },
  {
    id: "n3",
    name: "集合",
    parent_id: null,
    scope: "common",
    kind: "course",
    sort_order: 0,
    is_frozen: false,
  },
]

const report = {
  window: { days: 30 },
  participation: {
    student_count: 40,
    active_count: 30,
    answered_count: 300,
    correct_count: 210,
    practiced_days: 20,
  },
  node_accuracy: [
    { node_id: "n1", attempts: 20, correct: 5 },
    { node_id: "n2", attempts: 10, correct: 9 },
    { node_id: "n3", attempts: 2, correct: 0 },
  ],
  trend: [
    { date: "2026-11-01", answered: 10, correct: 7 },
    { date: "2026-11-02", answered: 0, correct: 0 },
    { date: "2026-11-03", answered: 5, correct: 5 },
  ],
}

ok("system 提示词稳定且包含白名单约束", () => {
  assert.ok(SYSTEM_PROMPT.includes("allowed_intents"))
  assert.ok(SYSTEM_PROMPT.includes("不写 SQL"))
  assert.ok(SYSTEM_PROMPT.includes("class_id"))
  assert.ok(SYSTEM_PROMPT.includes("student_id"))
  assert.ok(SYSTEM_PROMPT.includes("student_detail"))
})

ok("messages：user 带原话/班级/可用意图", () => {
  const messages = buildAnalyticsIntentMessages({
    text: "最近 30 天哪些知识点最弱",
    classInfo: { id: "c1", name: "计算机 1 班" },
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  const user = messages[1].content
  assert.ok(user.includes("最近 30 天哪些知识点最弱"))
  assert.ok(user.includes("计算机 1 班"))
  assert.ok(user.includes("weak_nodes"))
})

ok("合法 weak_nodes：通过并补 class_id", () => {
  const check = validateAnalyticsIntent(
    { intent: "weak_nodes", params: { days: 30 }, chart: "bar", title: "弱项" },
    { classId: "c1" }
  )
  assert.equal(check.ok, true)
  assert.equal(check.intent.params.class_id, "c1")
  assert.equal(check.intent.intent, "weak_nodes")
})

ok("班级参数与页面不一致：拒绝", () => {
  const check = validateAnalyticsIntent(
    { intent: "weak_nodes", params: { class_id: "c2", days: 30 } },
    { classId: "c1" }
  )
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("班级"))
})

ok("days 越界：夹到 7–90", () => {
  const low = validateAnalyticsIntent(
    { intent: "practice_trend", params: { days: 1 } },
    { classId: "c1" }
  )
  assert.equal(low.intent.params.days, 7)
  const high = validateAnalyticsIntent(
    { intent: "practice_trend", params: { days: 999 } },
    { classId: "c1" }
  )
  assert.equal(high.intent.params.days, 90)
})

ok("未知意图：拒绝", () => {
  const check = validateAnalyticsIntent({ intent: "drop_table" }, { classId: "c1" })
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("允许"))
})

ok("意图为 null + clarify：通过，交给页面给推荐问题", () => {
  const check = validateAnalyticsIntent(
    { intent: null, clarify: "目前只能回答班级知识点弱项与练习趋势" },
    { classId: "c1" }
  )
  assert.equal(check.ok, true)
  assert.equal(check.intent, null)
  assert.ok(check.clarify.includes("只能回答"))
})

ok("图表类型不在白名单：回落到默认", () => {
  const check = validateAnalyticsIntent(
    { intent: "weak_nodes", params: {}, chart: "pie" },
    { classId: "c1" }
  )
  assert.equal(check.ok, true)
  assert.equal(check.intent.chart, "bar")
})

ok("弱项行：过滤样本不足，按正确率升序，名称走科目树", () => {
  const rows = buildWeakNodesRows(report, nodes)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, "判别式")
  assert.equal(rows[0].accuracy, 0.25)
  assert.equal(rows[1].name, "函数")
})

ok("弱项摘要：带知识点与百分比", () => {
  const rows = buildWeakNodesRows(report, nodes)
  const summary = buildWeakNodesSummary(report, rows)
  assert.ok(summary.includes("判别式"))
  assert.ok(summary.includes("25%"))
})

ok("练习摘要：参与人数/题量/正确率", () => {
  const summary = buildPracticeSummary(report)
  assert.ok(summary.includes("30/40"))
  assert.ok(summary.includes("300"))
  assert.ok(summary.includes("70%"))
})

ok("趋势行：过滤零作答日", () => {
  const rows = buildPracticeTrendRows(report)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].date, "2026-11-01")
  assert.equal(rows[1].date, "2026-11-03")
})

ok("非对象：拒绝", () => {
  assert.equal(validateAnalyticsIntent(null, { classId: "c1" }).ok, false)
})

// ---------- 试卷口径 ----------

const stats = {
  stats: { attempts: 40 },
  items: [
    {
      seq: 1,
      qtype: "single_choice",
      graded: 30,
      correct_rate: 0.4,
      options: [
        { key: "A", text: "1", is_answer: true, count: 12 },
        { key: "B", text: "-1", is_answer: false, count: 18 },
      ],
    },
    {
      seq: 2,
      qtype: "fill_blank",
      graded: 20,
      correct_rate: 0.25,
      options: [],
      text_counts: [{ text: "-1", count: 15 }],
    },
    { seq: 3, qtype: "single_choice", graded: 3, correct_rate: 0.1, options: [] },
  ],
}

const quality = {
  summary: { note: "样本不足 30 人，区分度仅供参考" },
  items: [
    { seq: 1, qtype: "single_choice", n: 40, r_pb: 0.35, p_value: 0.6 },
    { seq: 2, qtype: "fill_blank", n: 30, r_pb: 0.12, p_value: 0.3 },
    { seq: 3, qtype: "single_choice", n: 5, r_pb: 0.05, p_value: 0.5 },
  ],
}

const board = {
  scope: { label: "全班" },
  stats: { total: 40 },
  rows: [
    { rank: 1, name: "张三", score: 95, full_score: 100, percent: 0.95 },
    { rank: 2, name: "李四", score: 90, full_score: 100, percent: 0.9 },
  ],
}

ok("试卷 messages：带 paper_id 与 scope", () => {
  const messages = buildAnalyticsIntentMessages({
    text: "这次考试哪几道题正确率最低",
    paperInfo: { id: "p1", title: "期中卷" },
    scope: "class",
    intents: ["question_stats", "leaderboard"],
  })
  const user = messages[1].content
  assert.ok(user.includes("p1"))
  assert.ok(user.includes("期中卷"))
  assert.ok(user.includes("question_stats"))
  assert.ok(user.includes("\"current_scope\": \"class\""))
})

ok("question_stats：补 paper_id/scope/class_id", () => {
  const check = validateAnalyticsIntent(
    { intent: "question_stats", params: { days: 30 } },
    { paperId: "p1", classId: "c1", scope: "class" }
  )
  assert.equal(check.ok, true)
  assert.equal(check.intent.params.paper_id, "p1")
  assert.equal(check.intent.params.scope, "class")
  assert.equal(check.intent.params.class_id, "c1")
})

ok("试卷参数与页面不一致：拒绝", () => {
  const check = validateAnalyticsIntent(
    { intent: "leaderboard", params: { paper_id: "p2" } },
    { paperId: "p1", scope: "class" }
  )
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("试卷"))
})

ok("scope 不在白名单：回落到当前页面", () => {
  const check = validateAnalyticsIntent(
    { intent: "leaderboard", params: { scope: "galaxy" } },
    { paperId: "p1", scope: "school" }
  )
  assert.equal(check.ok, true)
  assert.equal(check.intent.params.scope, "school")
})

ok("试题正确率行：过滤样本不足，按正确率升序", () => {
  const rows = buildQuestionStatsRows(stats)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].seq, 2)
  assert.equal(rows[0].correct_rate, 0.25)
  assert.equal(rows[1].top_wrong, "B. -1（18 人）")
})

ok("试题正确率摘要：带题号与百分比", () => {
  const rows = buildQuestionStatsRows(stats)
  const summary = buildQuestionStatsSummary(stats, rows)
  assert.ok(summary.includes("第 2 题"))
  assert.ok(summary.includes("25%"))
  assert.ok(summary.includes("40 人"))
})

ok("试题质量行：过滤样本不足，按区分度升序", () => {
  const rows = buildQuestionQualityRows(quality)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].seq, 2)
  assert.equal(rows[0].r_pb, 0.12)
})

ok("试题质量摘要：带 r 值与样本提示", () => {
  const rows = buildQuestionQualityRows(quality)
  const summary = buildQuestionQualitySummary(quality, rows)
  assert.ok(summary.includes("第 2 题"))
  assert.ok(summary.includes("0.12"))
  assert.ok(summary.includes("样本不足"))
})

ok("排行行与摘要", () => {
  const rows = buildLeaderboardRows(board)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, "张三")
  const summary = buildLeaderboardSummary(board, rows)
  assert.ok(summary.includes("全班"))
  assert.ok(summary.includes("40"))
  assert.ok(summary.includes("95/100"))
})

// ---------- 学生口径 ----------

const studentDetail = {
  student: { name: "小明" },
  node_accuracy: [
    { node_id: "n1", attempts: 20, correct: 5 },
    { node_id: "n2", attempts: 10, correct: 9 },
    { node_id: "n3", attempts: 2, correct: 0 },
  ],
  wrong_questions: [
    {
      question_id: "q1",
      qtype: "single_choice",
      stem_text: "下列关于 Word 的说法正确的是",
      wrong_count: 4,
    },
    {
      question_id: "q2",
      qtype: "true_false",
      stem_text: "Excel 中数字默认左对齐",
      wrong_count: 2,
    },
  ],
}

ok("学生 messages：只带 id 不带姓名", () => {
  const messages = buildAnalyticsIntentMessages({
    text: "他最弱的知识点是什么",
    studentInfo: { id: "s1" },
    intents: ["student_detail"],
  })
  const user = messages[1].content
  assert.ok(user.includes("\"current_student\""))
  assert.ok(user.includes("s1"))
  assert.ok(!user.includes("小明"))
  assert.ok(user.includes("student_detail"))
})

ok("合法 student_detail：补 student_id", () => {
  const check = validateAnalyticsIntent(
    { intent: "student_detail", params: {} },
    { allowedIntents: ["student_detail"], studentId: "s1" }
  )
  assert.equal(check.ok, true)
  assert.equal(check.intent.params.student_id, "s1")
})

ok("学生参数与页面不一致：拒绝", () => {
  const check = validateAnalyticsIntent(
    { intent: "student_detail", params: { student_id: "s2" } },
    { allowedIntents: ["student_detail"], studentId: "s1" }
  )
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("学生"))
})

ok("没有学生上下文：拒绝", () => {
  const check = validateAnalyticsIntent(
    { intent: "student_detail", params: {} },
    { allowedIntents: ["student_detail"] }
  )
  assert.equal(check.ok, false)
  assert.ok(check.reason.includes("学生"))
})

ok("学生行：过滤样本不足，按正确率升序，名称走科目树", () => {
  const rows = buildStudentDetailRows(studentDetail, nodes)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, "判别式")
  assert.equal(rows[0].accuracy, 0.25)
  assert.equal(rows[1].name, "函数")
})

ok("学生错题行：按错误次数降序", () => {
  const rows = buildStudentDetailWrongRows(studentDetail)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].question_id, "q1")
  assert.equal(rows[0].wrong_count, 4)
})

ok("学生摘要：带姓名/正确率/错题", () => {
  const rows = buildStudentDetailRows(studentDetail, nodes)
  const wrong = buildStudentDetailWrongRows(studentDetail)
  const summary = buildStudentDetailSummary(studentDetail, rows, wrong)
  assert.ok(summary.includes("小明"))
  assert.ok(summary.includes("25%"))
  assert.ok(summary.includes("Word"))
  assert.ok(summary.includes("4 次"))
})

console.log(`\n${passed} 项通过`)
