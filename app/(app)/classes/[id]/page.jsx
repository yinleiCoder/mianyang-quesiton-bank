// 班级学情看板（教师）：这个班哪里弱、谁掉队了。
//
// 为什么单独一条路由而不是塞进 /students 的页签：
//   · /students 是**名册**（分页、筛选、批量归班，语义是"找人"），看板是"看一个班的整体"，
//     两者没有共享的行级操作，塞一起只会让 ?tab= 与 ?page= 互相污染；
//   · 班级是实体（0063 建的 classes 表），它本来就该有一个能发到教研群里的 URL。
//
// 数据两块来源，各取所需：
//   · class_learning_report（0079）：参与度 / 趋势 / 知识点 / 高危题 / 预警；
//   · list_my_students（0063）：学生对照表——它已有每人的正确率与最近练习，
//     且权限门与看板一致，不重复实现。
//
// 权限：RPC 内部是 can_view_class（系统管理员 / 本校管理员 / 本校本专业教师），
// 越权抛 42501 → 这里显示「不能查看」而不是把 RPC 错误抛给错误边界。
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadSubjectNodes } from "@/lib/reference-data"
import { loadClassReport, percentText } from "@/lib/analytics"
import { gradeLabel, loadStudentRoster } from "@/lib/students"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { ParticipationPanel } from "@/components/classes/participation-panel"
import { WeaknessPanel } from "@/components/classes/weakness-panel"
import { AlertsPanel } from "@/components/classes/alerts-panel"
import { StudentTable } from "@/components/classes/student-table"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

// 时间窗：三档够用了。想加档就改这里与 RPC 的 clamp（7~180）。
const DAY_OPTIONS = [7, 30, 90]

export async function generateMetadata({ params }) {
  const { id } = await params
  return { title: `班级学情 ${id.slice(0, 8)}` }
}

export default async function ClassReportPage({ params, searchParams }) {
  const { id } = await params
  await requireUser()
  const ctx = await getAuthContext()
  if (!(ctx.isAdmin || ctx.isSchoolAdmin || ctx.isTeacher)) {
    return <AccessDenied title="仅教师及以上可访问" description="学生账号请使用客户端刷题。" />
  }

  const sp = (await searchParams) ?? {}
  const days = DAY_OPTIONS.includes(Number(sp.days)) ? Number(sp.days) : 30

  const supabase = await createClient()
  const [reportRes, rosterRes, nodes] = await Promise.all([
    loadClassReport(supabase, { classId: id, days }),
    loadStudentRoster(supabase, { classId: id, pageSize: 200 }),
    loadSubjectNodes(),
  ])

  if (reportRes.denied) {
    return (
      <AccessDenied
        title="不能查看这个班级的学情"
        description="只有本校、且专业覆盖这个班的教师（或管理员）能看。"
      />
    )
  }
  if (reportRes.error) throw reportRes.error

  const report = reportRes.report ?? {}
  const info = report.class ?? {}
  const p = report.participation ?? {}

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            nativeButton={false}
            render={<Link href={`/students?class=${id}`} />}
          >
            <ArrowLeftIcon className="size-4" /> 学生名册
          </Button>
          <PageHeader
            title={`${info.name ?? "班级"} · 学情`}
            description={
              <>
                {info.school_name ?? ""}
                {info.enroll_year ? ` · ${gradeLabel(info.enroll_year)}` : ""}
                <span className="mx-2 text-muted-foreground">·</span>
                最近 {report.window?.days ?? days} 天（{report.window?.from} ~ {report.window?.to}）
                <span className="mx-2 text-muted-foreground">·</span>
                客观题正确率口径：分母是已判分的客观题（{percentText(
                  p.answered_count > 0 ? p.correct_count / p.answered_count : null
                )}）
              </>
            }
          />
        </div>
        {/* 时间窗切换：与全站一致，换 URL = 换数据 */}
        <div className="flex items-center gap-1.5">
          {DAY_OPTIONS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === days ? "default" : "outline"}
              nativeButton={false}
              render={<Link href={`/classes/${id}?days=${d}`} />}
            >
              近 {d} 天
            </Button>
          ))}
        </div>
      </div>

      <ParticipationPanel report={report} />
      <WeaknessPanel report={report} nodes={nodes ?? []} />
      <AlertsPanel report={report} />
      <StudentTable rows={rosterRes.rows ?? []} />
    </div>
  )
}
