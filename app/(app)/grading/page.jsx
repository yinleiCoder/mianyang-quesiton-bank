// 阅卷队列：把「哪些卷子还有没批完的题」汇总成一页。
//
// 以前阅卷只有一条路：组卷库 → 试卷详情 → 阅卷按钮 —— 教师得先知道是哪份卷子。
// 学生一交卷，没有任何地方汇总"还有几场没批"，容易漏（2026-11-05 用户提）。
//
// 权限不在这一页判断：list_my_grading_queue 内部按 is_paper_grader 过滤，
// 没权限的人拿到的是空表。这里只负责画。
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { fmtDateTime24 } from "@/lib/format"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { ClipboardCheckIcon, ArrowRightIcon, ClockIcon } from "lucide-react"

export const metadata = { title: "阅卷" }

export default async function GradingQueuePage() {
  await requireUser()
  const supabase = await createClient()

  // 失败按空表处理：这是导航页，读不到数据不该把人挡在一张报错页上
  const { data } = await supabase.rpc("list_my_grading_queue")
  const rows = Array.isArray(data) ? data : []
  const totalPending = rows.reduce((sum, row) => sum + Number(row.pending_attempts ?? 0), 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title="阅卷"
        description="你负责的试卷里还没批完的场次。点进去逐题给分——主观题按计分点给，客观题可复核推翻。"
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardCheckIcon}
          title="没有待阅卷的场次"
          description="学生交卷后，只要卷子里有需要教师判分的题（简答、填空、综合），这份卷子就会出现在这里。"
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            共 <b className="tabular-nums text-foreground">{rows.length}</b> 份试卷、
            <b className="tabular-nums text-foreground"> {totalPending} </b>场待阅
          </p>
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.paper_id}>
                <Link
                  href={`/papers/${row.paper_id}/grading`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 transition-colors hover:border-primary/50 hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-medium">{row.title ?? "（试卷）"}</h3>
                    <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>第 {row.version_no ?? 1} 版</span>
                      <span className="inline-flex items-center gap-1">
                        <ClockIcon className="size-3.5" />
                        最近交卷 {fmtDateTime24(row.last_submitted_at)}
                      </span>
                      {Number(row.in_grading) > 0 && (
                        <span>{row.in_grading} 场已批了一部分</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium tabular-nums text-amber-700">
                      {row.pending_attempts} 场待阅
                    </span>
                    <ArrowRightIcon className="size-4 text-muted-foreground" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
