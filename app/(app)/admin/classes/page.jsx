// 班级管理：学校管理员建本校的班，系统管理员可管任意学校。
// 与「科目树维护」（系统管理员的专业建设）并列 —— 专业目录由市级统一维护，
// 班级是各校自己的排班，各管一层。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadMyClassOptions } from "@/lib/students"
import { loadSchools, loadSubjectNodes } from "@/lib/reference-data"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { ClassesManager } from "@/components/admin/classes-manager"

export const metadata = { title: "班级管理" }

export default async function AdminClassesPage() {
  const ctx = await requireUser()
  if (!(ctx.isAdmin || ctx.isSchoolAdmin)) {
    return <AccessDenied title="仅学校管理员及以上可访问" />
  }
  if (ctx.isSchoolAdmin && !ctx.isAdmin && !ctx.profile?.school_id) {
    return <AccessDenied title="档案异常" description="你的档案未绑定学校，请先联系系统管理员绑定。" />
  }

  const supabase = await createClient()
  // 班级列表走 list_my_student_classes：它按角色限定范围（管理员全部 / 学校管理员本校），
  // 顺带带回人数与班级汇总正确率 —— 管理页正好也要看这些。
  const [{ classes, error }, schools, nodes] = await Promise.all([
    loadMyClassOptions(supabase),
    ctx.isAdmin ? loadSchools() : Promise.resolve([]),
    loadSubjectNodes(),
  ])
  if (error) throw error

  return (
    <div className="space-y-4">
      <PageHeader
        title="班级管理"
        description={
          ctx.isAdmin
            ? "各校班级的建立与维护。班级绑定一个专业大类或专业，学生的专业大类、专业与入学年份都由班级带出 —— 学生端只选班级，不再手输专业。"
            : "本校班级的建立与维护。班级绑定一个专业大类或专业，学生的专业大类、专业与入学年份都由班级带出。建好班后，到「本校学生」里把未分班的学生批量归入。"
        }
      />
      <ClassesManager
        classes={classes ?? []}
        schools={schools}
        nodes={nodes ?? []}
        caller={{
          isAdmin: ctx.isAdmin,
          schoolId: ctx.profile?.school_id ?? null,
        }}
      />
    </div>
  )
}
