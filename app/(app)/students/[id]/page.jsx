// 单个学生的学情：就读信息 + 练习概况 + 练习历史 + 错题 + 考试成绩。
// 一次 RPC 取全（my_student_detail 返回 jsonb），所以这里只有一个 Suspense 边界 ——
// 拆成六个边界反而违背那个「一次取全」的设计，各自 await 一遍就是六次往返。
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadStudentDetail } from "@/lib/students"
import { loadSubjectNodes } from "@/lib/reference-data"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { StudentDetail } from "@/components/students/student-detail"
import { ArrowLeftIcon } from "lucide-react"

export const metadata = { title: "学生学情" }

export default async function StudentDetailPage({ params }) {
  const { id } = await params
  const ctx = await requireUser()
  if (!(ctx.isAdmin || ctx.isSchoolAdmin || ctx.isTeacher)) {
    return <AccessDenied title="仅教师及以上可访问" />
  }

  const supabase = await createClient()
  const [nodes, { detail, denied, error }] = await Promise.all([
    loadSubjectNodes(),
    loadStudentDetail(supabase, id),
  ])
  // 42501 = can_view_student 判定无权（跨专业 / 跨校 / 不是学生）。
  // 这不是"出错"，是正常的越权拦截，按 AccessDenied 渲染而不是抛给错误边界。
  if (denied) {
    return (
      <AccessDenied
        title="不能查看该学生"
        description="你只能查看本校且专业与你任教专业匹配的学生。若确有需要，请联系学校管理员调整你的任教专业。"
      />
    )
  }
  if (error) throw error

  return (
    <div className="space-y-4">
      <Link
        href="/students"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" /> 返回学生名册
      </Link>
      <PageHeader
        title={detail?.student?.name || "学生"}
        description="练习与考试数据来自学生在客户端（App）里的作答上报。"
      />
      <StudentDetail detail={detail} nodes={nodes} />
    </div>
  )
}
