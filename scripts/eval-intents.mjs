// 轻量指标：一句话组卷 + 学情问数的意图命中率。
//
// 不是 npm test 的一部分：它会真的调 DeepSeek，消耗使用者自己的额度。
//   DEEPSEEK_KEY=... npm run eval:intents
// 输出一份可贴进比赛材料的 JSON + 控制台表格；样本是模拟教师口语，
// 真实教师样本应替换 PAPER_CASES / ANALYTICS_CASES 后重跑。
import { callChat, salvageJson } from "@/lib/deepseek"
import { buildPaperIntentMessages, validatePaperIntent } from "@/lib/paper-intent-prompt"
import { buildAnalyticsIntentMessages, validateAnalyticsIntent } from "@/lib/analytics-intent"
import { QTYPES } from "@/lib/question-model"

const key = process.env.DEEPSEEK_KEY
if (!key) {
  console.error("请先设置 DEEPSEEK_KEY")
  process.exit(1)
}
const model = process.env.DEEPSEEK_MODEL || "deepseek-flash"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const node = { id: "node-cs", name: "计算机应用", parent_id: null }
const tags = ["Word", "Excel", "PPT", "Access", "局域网", "数据库", "操作系统", "办公应用"].map(
  (name, index) => ({ id: `t${index + 1}`, name, parent_id: null })
)
const qtypeValues = QTYPES.map((q) => q.value)

async function ask(messages, maxTokens, temperature) {
  let last = ""
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(600 * attempt)
    try {
      const res = await callChat({
        messages,
        apiKey: key,
        model,
        maxTokens,
        temperature,
      })
      return { content: res.content, finishReason: res.finishReason }
    } catch (err) {
      last = err?.message || "调用失败"
    }
  }
  return { error: last }
}

// ---------- P0-1 一句话组卷 ----------
// target / sections 为人工标注的期望；sections: null 表示只检查目标分（默认结构允许变化）。
const PAPER_CASES = [
  { text: "出一份 100 分的计算机基础期末卷，单选 20 题每题 2 分，填空 10 题每题 2 分，剩下 40 分放主观题", target: 100, sections: 3 },
  { text: "来一份 90 分的 Word 专项练习，基础 70%、中档 20%、难 10%，最近 30 天用过的题排除", target: 90, sections: null },
  { text: "组一份 60 分的小测，10 道单选每题 3 分，5 道判断每题 2 分，4 道填空每题 5 分", target: 60, sections: 3 },
  { text: "出一份 120 分的 Excel 综合卷，单选 20 题 2 分，多选 10 题 3 分，填空 10 题 2 分，操作题 3 题 10 分", target: 120, sections: 4 },
  { text: "给我一份 80 分的 Access 数据库试卷，全部用单选题，20 题每题 4 分", target: 80, sections: 1 },
  { text: "出一份 100 分的卷子，50 道单选每题 2 分", target: 100, sections: 1 },
  { text: "来一份 90 分的计算机基础期中卷，基础 60%、中档 30%、难 10%", target: 90, sections: null },
  { text: "出一份 150 分的计算机专业综合卷，单选 30 题 2 分，填空 15 题 2 分，简答 4 题 10 分，综合 2 题 15 分", target: 150, sections: 4 },
  { text: "组一份 70 分的 PPT 练习，单选 10 题 3 分，判断 10 题 2 分，填空 5 题 4 分", target: 70, sections: 3 },
  { text: "出一份 100 分的试卷，难度基础 50%、中档 40%、难 10%，不要最近两个月用过的题", target: 100, sections: null },
  { text: "来一份 50 分的小测，10 道判断每题 2 分，10 道单选每题 3 分", target: 50, sections: 2 },
  { text: "出一份 110 分的计算机应用卷，单选 20 题 2 分，填空 10 题 3 分，简答 4 题 10 分", target: 110, sections: 3 },
  { text: "出一份试卷", clarify: true },
  { text: "帮我找点题", clarify: true },
  { text: "这次考试很难", clarify: true },
]

async function evalPaper() {
  const rows = []
  for (const item of PAPER_CASES) {
    const messages = buildPaperIntentMessages({
      text: item.text,
      node: item.clarify ? null : node,
      nodes: item.clarify ? [] : [node],
      tags: item.clarify ? [] : tags,
      qtypes: QTYPES,
    })
    let check = null
    let lastError = ""
    // 与生产面板一致：格式不对最多重试 3 次，按“最终是否可用”计成功率。
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(600 * attempt)
      const res = await ask(messages, 3000, 0.2)
      if (res.error) {
        lastError = res.error
        continue
      }
      check = validatePaperIntent(salvageJson(res.content), {
        allowedNodeIds: item.clarify ? [] : [node.id],
        allowedTags: item.clarify ? [] : tags,
        allowedQtypes: qtypeValues,
      })
      const clarifyOk = item.clarify
        ? check.ok && Boolean(check.intent?.clarify)
        : check.ok && !check.intent?.clarify
      const targetOk =
        item.target == null ? null : check.ok && Number(check.intent?.target_score) === item.target
      const sectionsOk =
        item.sections == null
          ? null
          : check.ok && (check.intent?.sections?.length ?? -1) === item.sections
      if (clarifyOk && targetOk !== false && sectionsOk !== false) break
    }
    const clarifyOk = check?.ok
      ? item.clarify
        ? Boolean(check.intent?.clarify)
        : !check.intent?.clarify
      : false
    const targetOk =
      item.target == null
        ? null
        : Boolean(check?.ok) && Number(check.intent?.target_score) === item.target
    const sectionsOk =
      item.sections == null
        ? null
        : Boolean(check?.ok) && (check.intent?.sections?.length ?? -1) === item.sections
    rows.push({
      text: item.text,
      parsed: clarifyOk,
      targetOk,
      sectionsOk,
      ok: clarifyOk && targetOk !== false && sectionsOk !== false,
      got: check?.ok
        ? { target: check.intent?.target_score, sections: check.intent?.sections?.length, clarify: check.intent?.clarify ?? "" }
        : { reason: check?.reason ?? lastError ?? "调用失败" },
    })
    await sleep(250)
  }
  const total = rows.length
  const parsed = rows.filter((row) => row.parsed).length
  const fieldOk = rows.filter((row) => row.ok).length
  return { total, parsed, fieldOk, rows }
}

// ---------- P1-1 学情问数 ----------
const CLASS_CASES = [
  ["最近 30 天班里哪些知识点最弱？", "weak_nodes"],
  ["近两周大家的练习量怎么样？", "practice_trend"],
  ["哪些知识点错得最多？", "weak_nodes"],
  ["这一个月班里同学做题是变多了还是变少了？", "practice_trend"],
  ["本周参与练习的人数有多少？", "practice_trend"],
  ["哪几个知识点掌握最差？", "weak_nodes"],
  ["最近 7 天正确率怎么样？", "practice_trend"],
  ["给我看看最薄弱的三个知识点", "weak_nodes"],
  ["大家的练习天数有变化吗？", "practice_trend"],
  ["这个班最近练习情况如何？", "practice_trend"],
]
const PAPER_CASES_Q = [
  ["这次考试哪几道题正确率最低？", "question_stats"],
  ["区分度最低的题是哪几道？", "question_quality"],
  ["成绩榜前几名是谁？", "leaderboard"],
  ["最容易错的题是哪几道？", "question_stats"],
  ["哪些题的干扰项有问题？", "question_quality"],
  ["这次考试第一名是谁？", "leaderboard"],
]
const STUDENT_CASES = [
  ["这个学生最近练得怎么样？", "student_detail"],
  ["他最弱的知识点是什么？", "student_detail"],
  ["错得最多的题是哪些？", "student_detail"],
  ["他最近两周的学习情况怎么样？", "student_detail"],
]

async function evalAnalytics() {
  const groups = [
    {
      context: "class",
      cases: CLASS_CASES,
      allowed: ["weak_nodes", "practice_trend"],
      build: { classInfo: { id: "c1", name: "计算机 1 班" } },
      validate: { classId: "c1" },
    },
    {
      context: "paper",
      cases: PAPER_CASES_Q,
      allowed: ["question_stats", "question_quality", "leaderboard"],
      build: { paperInfo: { id: "p1", title: "计算机类试题" }, scope: "class" },
      validate: { paperId: "p1", classId: "c1", scope: "class" },
    },
    {
      context: "student",
      cases: STUDENT_CASES,
      allowed: ["student_detail"],
      build: { studentInfo: { id: "s1" } },
      validate: { studentId: "s1" },
    },
  ]
  const rows = []
  for (const group of groups) {
    for (const [text, expected] of group.cases) {
      const messages = buildAnalyticsIntentMessages({
        text,
        ...group.build,
        intents: group.allowed,
      })
      let check = null
      let lastError = ""
      // 与生产面板一致：格式不对最多重试 3 次。
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(600 * attempt)
        const res = await ask(messages, 800, 0.1)
        if (res.error) {
          lastError = res.error
          continue
        }
        check = validateAnalyticsIntent(salvageJson(res.content), {
          allowedIntents: group.allowed,
          ...group.validate,
        })
        if (check.ok && check.intent?.intent === expected) break
      }
      rows.push({
        context: group.context,
        text,
        expected,
        got: check?.ok ? check.intent?.intent ?? "clarify" : `拒绝：${check?.reason ?? lastError}`,
        hit: Boolean(check?.ok) && check.intent?.intent === expected,
      })
      await sleep(200)
    }
  }
  const total = rows.length
  const hits = rows.filter((row) => row.hit).length
  return { total, hits, rows }
}

const paper = await evalPaper()
const analytics = await evalAnalytics()
const report = {
  model,
  generatedAt: new Date().toISOString(),
  paperIntent: {
    total: paper.total,
    parsedRate: paper.total ? paper.parsed / paper.total : 0,
    fieldRate: paper.total ? paper.fieldOk / paper.total : 0,
    rows: paper.rows,
  },
  analyticsIntent: {
    total: analytics.total,
    hitRate: analytics.total ? analytics.hits / analytics.total : 0,
    rows: analytics.rows,
  },
}

console.log(JSON.stringify(report, null, 2))
console.log("\n=== 摘要 ===")
console.log(`一句话组卷：解析成功 ${paper.parsed}/${paper.total}，字段全对 ${paper.fieldOk}/${paper.total}`)
console.log(`学情问数：意图命中 ${analytics.hits}/${analytics.total}`)
