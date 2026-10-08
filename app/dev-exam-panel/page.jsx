// 渲染检查页（fixture）：给班级学情的「考试结果」组件（0087）过一遍真实渲染。
//
// ⚠ **不要删掉它**（2026-10-08 用户要求：删任何东西之前先问）。
//   它只渲染下面写死的假数据，不读数据库、不调上游，任何账号都能打开；
//   留着 = 下次改那张卡片的排版时不用再造一遍样本。
//
// 数据是 0087 线上真实返回的形状（取自 2026-10-05 的 class_exam_results 调用）。
import { notFound } from "next/navigation"
import { ExamResultsPanel } from "@/components/classes/exam-results-panel"

const CLASS_ID = "552009da-9193-4e34-8ff2-e742c754e0a2"

const full = {
  student_count: 27,
  window: { days: 90, from: "2026-07-07", to: "2026-10-04" },
  max_papers: 12,
  truncated: true,
  papers: [
    {
      paper_id: "ac86e905-2ce4-47eb-8e17-6beb81084283",
      title: "【测试】客户端联调卷",
      exam_name: "四川省2026年盐亭职校月考卷",
      subject_label: "计算机",
      full_score: 32,
      last_submitted_at: "2026-10-02T08:43:09+00:00",
      participants: 2,
      ungraded: 1,
      stats: { avg_score: 25.6, avg_percent: 0.8, max_score: 28.8, min_score: 22.4 },
      top: { name: "于钞", score: 28.8, percent: 0.9 },
      bottom: { name: "何家进", score: 22.4, percent: 0.7 },
      most_improved: { name: "何家进", delta: 0.7, percent: 0.7, prev_percent: 0 },
      distribution: [
        { key: "lt60", label: "60% 以下", count: 0 },
        { key: "p60", label: "60~69%", count: 0 },
        { key: "p70", label: "70~79%", count: 1 },
        { key: "p80", label: "80~89%", count: 0 },
        { key: "p90", label: "90% 以上", count: 1 },
      ],
    },
    {
      paper_id: "24e5ae77-c631-4d01-a77c-d0533e21a1c0",
      title: "24级计算机模拟卷（一）",
      exam_name: null,
      subject_label: null,
      full_score: 6,
      last_submitted_at: "2026-09-24T08:43:09+00:00",
      participants: 6,
      ungraded: 0,
      stats: { avg_score: 3.5, avg_percent: 0.5833, max_score: 6, min_score: 0 },
      top: { name: "于钞", score: 6, percent: 1 },
      bottom: { name: "何家进", score: 0, percent: 0 },
      most_improved: null,
      distribution: [
        { key: "lt60", label: "60% 以下", count: 4 },
        { key: "p60", label: "60~69%", count: 0 },
        { key: "p70", label: "70~79%", count: 0 },
        { key: "p80", label: "80~89%", count: 0 },
        { key: "p90", label: "90% 以上", count: 2 },
      ],
    },
  ],
}

// 边界：一份卷全员待阅卷（班均 null、没有最高/最低/进步），以及完全空
const allPending = {
  student_count: 27,
  window: { days: 30, from: "2026-09-05", to: "2026-10-04" },
  max_papers: 12,
  truncated: false,
  papers: [
    {
      paper_id: "ac86e905-2ce4-47eb-8e17-6beb81084283",
      title: "全部待阅卷的卷子",
      full_score: 100,
      last_submitted_at: "2026-10-04T08:43:09+00:00",
      participants: 0,
      ungraded: 3,
      stats: { avg_score: null, avg_percent: null, max_score: null, min_score: null },
      top: null,
      bottom: null,
      most_improved: null,
      distribution: [
        { key: "lt60", label: "60% 以下", count: 0 },
        { key: "p60", label: "60~69%", count: 0 },
        { key: "p70", label: "70~79%", count: 0 },
        { key: "p80", label: "80~89%", count: 0 },
        { key: "p90", label: "90% 以上", count: 0 },
      ],
    },
  ],
}

const empty = { student_count: 27, window: { days: 7, from: "2026-09-28", to: "2026-10-04" }, papers: [] }

export default function DevExamPanelPage() {
  // 线上直接 404：它只是假数据，但没理由让生产多一个调试页。本地与 Vercel preview 照常可用
  // （VERCEL_ENV 只在 Vercel 上定义，本地是 undefined）。
  if (process.env.VERCEL_ENV === "production") notFound()
  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <ExamResultsPanel results={full} classId={CLASS_ID} />
      <ExamResultsPanel results={allPending} classId={CLASS_ID} />
      <ExamResultsPanel results={empty} classId={CLASS_ID} />
    </main>
  )
}
