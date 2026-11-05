// 渲染检查页（fixture）：讲评教案的模板兜底。
//
// ⚠ **不要删掉它**（2026-10-08 用户要求：删任何东西之前先问）。
//   只渲染写死的假报告 + 模板教案，不读数据库、不调模型，任何账号都能打开。
import { notFound } from "next/navigation"
import { LessonPlanView } from "@/components/classes/lesson-plan-view"
import { buildFallbackLessonPlan } from "@/lib/lesson-plan-fallback"

const REPORT = {
  weak_points: [
    {
      point: "Excel 函数与单元格引用",
      evidence: "第 5、7 题错误率超过 60%，高分组也有 3 人选错",
      suggestion: "用相对/绝对引用的对照表讲，现场改 $ 符号看结果",
    },
  ],
  error_analysis: [
    {
      seq: 5,
      label: "相对引用与绝对引用混淆",
      evidence: "高分组有 3 人选错，低分组 7 人选错",
      suggestion: "在黑板上把同一公式的 A1/$A$1 各算一遍，让学生说差别",
    },
    {
      seq: 7,
      label: "函数参数顺序记反",
      evidence: "错误集中在第二个参数",
      suggestion: "用“先范围、后条件”的口诀，配一道改错题",
    },
  ],
  question_notes: [{ seq: 5, note: "干扰项 B 是绝对引用，学生凭印象选" }],
  action_plan: [
    { action: "用 10 分钟做 $ 符号对照练习", when: "下一节课", metric: "同类 5 题正确率达到 70%" },
    { action: "布置 3 道函数参数改错题", when: "本周内", metric: "改错题全对" },
  ],
}

const PLAN = buildFallbackLessonPlan({
  report: REPORT,
  paper: { title: "计算机类试题" },
  classInfo: { name: "3班陶建" },
  summary: { participants: 38 },
  durationMinutes: 45,
})

export default function DevLessonPlanPage() {
  if (process.env.VERCEL_ENV === "production") notFound()

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">讲评教案夹具</h1>
      <p className="text-sm text-muted-foreground">
        下面是由模板兜底生成的 45 分钟教案；它不调用模型、不需要密钥。AI 精修走的是同一份结构。
      </p>
      <LessonPlanView plan={PLAN} />
    </main>
  )
}
