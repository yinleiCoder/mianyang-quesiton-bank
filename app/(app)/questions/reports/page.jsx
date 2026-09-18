// 题目反馈收件箱：学生反馈的题目问题在这里汇总给作者处理。
//
// 谁能看到由 RPC 内部断言 + RLS 决定（作者 / 学校管理员 / 系统管理员），
// 页面不做二次过滤 —— 复刻一份权限判断迟早会和 SQL 漂移。
//
// 侧栏入口只对教师显示（学生的"我的题目"里本来就没有题），
// 但**直接访问也不会越权**：RPC 会拦。这是刻意的取舍 —— 入口按角色隐藏是省事，
// 权限靠服务端兜底才是安全边界。
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { loadReportInbox, REPORT_FILTERS } from "@/lib/question-reports"
import { indexNodes } from "@/lib/subject-nodes"
import { loadSubjectNodes } from "@/lib/reference-data"
import { PageHeader } from "@/components/page-header"
import { ReportInbox } from "@/components/questions/report-inbox"
import { cn } from "cn"

export const metadata = { title: "题目反馈" }

export default async function QuestionReportsPage({ searchParams }) {
  const { status = "open" } = await searchParams
  const supabase = await createClient()

  const [{ rows, total }, nodes] = await Promise.all([
    loadReportInbox(supabase, { status }),
    loadSubjectNodes(),
  ])

  // 课程节点路径在页面上比 UUID 有用得多 —— 作者一眼能看出这是哪一章的题
  const { pathOf } = indexNodes(nodes)
  const list = rows.map((r) => ({ ...r, course_node_path: pathOf(r.course_node_id) }))

  return (
    <div className="space-y-4">
      <PageHeader
        title="题目反馈"
        description="学生在做题时上报的题目问题。处理时请写一句说明 —— 提交人会在那道题下面看到它。"
      />

      <div className="flex flex-wrap gap-1.5">
        {REPORT_FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/questions/reports?status=${f.key}`}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition-colors",
              status === f.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            )}
          >
            {f.label}
          </Link>
        ))}
        <span className="ml-auto self-center text-xs text-muted-foreground">共 {total} 条</span>
      </div>

      <ReportInbox rows={list} status={status} />
    </div>
  )
}
