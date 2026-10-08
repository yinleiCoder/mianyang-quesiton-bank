// 班级 AI 分析（0088）：一份卷 + 一个班的 AI 报告，独立一页。
//
// 为什么独立成页而不是塞进班级看板的卡片里：
//   · 报告有六七段，展开在卡片里会把班级页拉得没法看；
//   · 它要能**发到教研群**——同科教师点开就是同一份（报告存在库里、全班共用）。
//
// 数据一次取齐（class_ai_report 一个 RPC 回：卷面、班级、成绩概览、当前指纹、已存的报告）。
// **AI 调用不在这一页发生**：密钥只存在教师自己的浏览器里，生成在客户端组件里跑
// （见 components/classes/ai-report-panel.jsx 的头注）。服务端只负责"给数据 + 存结果"。
//
// 权限：can_view_class（与班级学情看板一致），越权时 RPC 抛 42501 → 显示「不能查看」。
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadClassAiReport } from "@/lib/class-ai"
import { percentText } from "@/lib/analytics"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { AiReportPanel } from "@/components/classes/ai-report-panel"
import { ScoreDistribution } from "@/components/classes/score-distribution"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

export async function generateMetadata({ params }) {
  const { id } = await params
  return { title: `AI 分析 ${id.slice(0, 8)}` }
}

export default async function ClassAiReportPage({ params }) {
  const { id, paperId } = await params
  await requireUser()
  const ctx = await getAuthContext()
  if (!(ctx.isAdmin || ctx.isSchoolAdmin || ctx.isTeacher)) {
    return <AccessDenied title="仅教师及以上可访问" description="学生账号请使用客户端刷题。" />
  }

  const supabase = await createClient()
  const { data, denied, error } = await loadClassAiReport(supabase, { paperId, classId: id })
  if (denied) {
    return (
      <AccessDenied
        title="不能查看这个班级的 AI 分析"
        description="只有本校、且专业覆盖这个班的教师（或管理员）能看。"
      />
    )
  }
  if (error) throw error

  const info = data?.class ?? {}
  const paper = data?.paper ?? {}
  const summary = data?.summary ?? {}
  const participants = Number(summary.participants) || 0

  return (
    <div className="space-y-4">
      <div className="min-w-0 space-y-1">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          nativeButton={false}
          render={<Link href={`/classes/${id}`} />}
        >
          <ArrowLeftIcon className="size-4" /> 班级学情
        </Button>
        <PageHeader
          title={`AI 分析 · ${paper.title ?? "试卷"}`}
          description={
            <>
              {info.name ?? "班级"}
              {paper.exam_name ? ` · ${paper.exam_name}` : ""}
              {paper.subject_label ? ` · ${paper.subject_label}` : ""}
              <span className="mx-2 text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                满分 {Number(paper.full_score) || 0} · 题目 {Number(paper.question_count) || 0} 道
              </span>
            </>
          }
        />
      </div>

      {/* 成绩概览：先给事实，再给结论。图与文字并列才是"看得懂"，光有数字或光有文字都不行 */}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span>
              参加{" "}
              <b className="tabular-nums">
                {participants}/{Number(info.student_count) || 0}
              </b>{" "}
              人
            </span>
            {summary.avg_percent != null && (
              <span className="text-muted-foreground">
                班均 <b className="text-foreground tabular-nums">{percentText(summary.avg_percent)}</b>
              </span>
            )}
            {summary.median_percent != null && (
              <span className="text-muted-foreground">
                中位 <b className="text-foreground tabular-nums">{percentText(summary.median_percent)}</b>
              </span>
            )}
            {summary.max_percent != null && (
              <span className="text-muted-foreground tabular-nums">
                最高 {percentText(summary.max_percent)} · 最低 {percentText(summary.min_percent)}
              </span>
            )}
            {Number(summary.ungraded) > 0 && (
              <span className="text-amber-600">另有 {summary.ungraded} 人待阅卷，未计入</span>
            )}
          </div>
          {participants > 0 && <ScoreDistribution rows={summary.distribution ?? []} />}
        </CardContent>
      </Card>

      <AiReportPanel paperId={paperId} classId={id} initial={data} paperTitle={paper.title} />
    </div>
  )
}
