// 用户与任命：系统管理员全校视角；学校管理员仅本校用户（可任命/撤销本校教研组长）
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadAdminUserDirectory } from "@/lib/admin-users"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { UsersManager } from "@/components/admin/users-manager"
import { TeacherReviewQueue } from "@/components/admin/teacher-review-queue"

export const metadata = { title: "用户与任命" }

export default async function AdminUsersPage() {
  const ctx = await requireUser()
  const canManage = ctx.isAdmin || ctx.isSchoolAdmin
  if (!canManage) {
    return <AccessDenied title="仅学校管理员及以上可访问" />
  }
  if (ctx.isSchoolAdmin && !ctx.profile?.school_id) {
    return <AccessDenied title="档案异常" description="你的档案未绑定学校，请先联系系统管理员绑定。" />
  }

  const supabase = await createClient()
  const { profiles, schools, roleRows, assignments, nodes } = await loadAdminUserDirectory(supabase, {
    isAdmin: ctx.isAdmin,
    schoolId: ctx.profile?.school_id ?? null,
  })
  // 装载函数把查询失败表达为 null（客户端重查时用于「保留旧值」）；
  // 服务端首屏没有旧值可保留，null 即失败 → 抛出交给错误边界，避免渲染成空列表。
  if (!profiles || !schools || !roleRows || !nodes) {
    throw new Error("用户与任命数据装载失败")
  }

  const schoolNames = new Map(schools.map((s) => [s.id, s.name]))

  return (
    <div className="space-y-4">
      <PageHeader
        title={ctx.isAdmin ? "用户与任命" : "本校用户与任命"}
        description={
          ctx.isAdmin
            ? "系统管理员：任命学校管理员与市级专家（按科目节点，全市生效）；教研组长由各校学校管理员任命。一岗一人，任命覆盖该节点及后代科目。"
            : "学校管理员：仅能操作本校用户，为教师任命教研组长（按学校+科目节点，覆盖该节点及后代科目）；可删除本校教师。一岗一人。学校管理员与市级专家账号需由系统管理员删除。"
        }
      />
      <TeacherReviewQueue
        pendingUsers={profiles
          .filter((p) => p.identity === "teacher_pending")
          .map((p) => ({ ...p, schoolName: schoolNames.get(p.school_id) ?? null }))}
      />
      <UsersManager
        users={profiles}
        schools={schools}
        roleRows={roleRows}
        assignments={assignments}
        nodes={nodes}
        caller={{
          isAdmin: ctx.isAdmin,
          isSchoolAdmin: ctx.isSchoolAdmin,
          schoolId: ctx.profile?.school_id ?? null,
          meId: ctx.user?.id ?? null,
        }}
      />
    </div>
  )
}
