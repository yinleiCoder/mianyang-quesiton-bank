// 渲染检查页（fixture）：给 AI 分析的展示组件过一遍真实渲染（截图 / 报错 / 空态）。
//
// ⚠ **不要删掉它**（2026-10-08 用户要求：删任何东西之前先问）。
//   它只渲染下面写死的假数据，不读数据库、不调上游，任何账号都能打开；
//   留着 = 下次改 AI 报告的排版时不用再造一遍样本。真要从生产里摘掉，也先问一声。
//
// 数据结构取自 0088 存的报告（content 是模型按 lib/ai-report-prompt.js 的 schema 返回的那个对象）。
import { notFound } from "next/navigation"
import { AiReportView } from "@/components/classes/ai-report-view"
import { AiReportPanel } from "@/components/classes/ai-report-panel"

const REPORT = {
  overview:
    "本次 6 人参加（全班 27 人），班均得分率 58%，最高 100%、最低 0%，两极分化非常明显。第 1 题（形状控制点）6 人中 4 人对、2 人错选 A；第 2 题（多选图形对象）只有 3 人对。整体处在「基础操作会、概念辨析不过关」的状态。",
  strengths: ["基本作图操作类题目正确率过半", "全体都完成了作答，没有空白卷"],
  key_points: [
    { point: "办公应用 · 图形基本操作", mastery: "一般", evidence: "第 1 题 4/6 对（67%）" },
    { point: "办公应用 · 多对象选择", mastery: "薄弱", evidence: "第 2 题 3/6 对（50%）" },
  ],
  weak_points: [
    {
      point: "形状控制点的辨认",
      evidence: "学生3、学生5 都选了 A（绿色控制点），把旋转控制点当成了形状控制点",
      suggestion: "课上把同一个图形分别点出三种控制点，让学生说出手柄形状的差别",
    },
    {
      point: "多对象选择的修饰键",
      evidence: "学生4、学生5、学生6 三人都错，是全班最集中的错误",
      suggestion: "用一个「选取两个不相邻图形」的小任务当场练一遍 Ctrl/Shift 的区别",
    },
  ],
  question_notes: [
    { seq: 1, note: "干扰项 A 是旋转控制点，学生凭颜色记忆容易误选，要讲「看形状不看颜色」。" },
    { seq: 2, note: "错答集中在 B（框选），说明学生把「框选」和「按 Ctrl 点选」混为一谈。" },
  ],
  plan: {
    consolidate: ["用 10 分钟辨认同一个图形的形状/旋转/调整控制点", "把 Ctrl 与 Shift 的选择差异做成一道 30 秒的随堂小测"],
    extend: ["延伸到按住 Ctrl 拖拽复制对象（多对象操作的常见组合）"],
    improve: ["给一道「重排三个图形并保持对齐」的综合任务，练选择 + 分布 + 对齐的组合操作"],
  },
  caveats: "本次只有 6 人参加、每题 6 次作答，样本很小；另外 21 人没有成绩，不能代表全班水平。",
}

const INITIAL = {
  paper: { title: "24级计算机模拟卷（一）", exam_name: "四川省2026年盐亭职校月考卷", subject_label: "计算机", full_score: 6, question_count: 2 },
  class: { id: "552009da", name: "1班何亚章", student_count: 27 },
  summary: { participants: 6, ungraded: 0, avg_percent: 0.5833, median_percent: 0.5, max_percent: 1, min_percent: 0 },
  fingerprint: "4e2bc712a6b4d48c5e7a192ad4d78193",
  report: {
    content: REPORT,
    model: "deepseek-flash",
    created_at: "2026-10-08T07:20:00+00:00",
    created_by_name: "尹磊",
    author_left: false,
    fingerprint: "4e2bc712a6b4d48c5e7a192ad4d78193",
  },
  stale: true,
}

const EMPTY = { ...INITIAL, report: null, stale: false }

export default function DevAiReportPage() {
  // 线上直接 404：它只是假数据，但没理由让生产多一个调试页。本地与 Vercel preview 照常可用
  // （VERCEL_ENV 只在 Vercel 上定义，本地是 undefined）。
  if (process.env.VERCEL_ENV === "production") notFound()
  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <section>
        <h2 className="mb-2 text-xs text-muted-foreground">/ 有报告（且已过期）</h2>
        <AiReportPanel paperId="p1" classId="c1" initial={INITIAL} paperTitle="24级计算机模拟卷（一）" />
      </section>
      <section>
        <h2 className="mb-2 text-xs text-muted-foreground">/ 还没生成过</h2>
        <AiReportPanel paperId="p1" classId="c1" initial={EMPTY} paperTitle="24级计算机模拟卷（一）" />
      </section>
      <section>
        <h2 className="mb-2 text-xs text-muted-foreground">/ 只有一段 overview（模型漏字段）</h2>
        <AiReportView report={{ overview: "只有这一段。" }} />
      </section>
    </main>
  )
}
