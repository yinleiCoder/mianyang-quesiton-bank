// 鉴权 DAL：唯一入口拿"当前登录用户 + 档案 + 角色"，每个 Server Action / Route Handler / 页面自查。
// 依赖：profiles.school_id 档案；user_roles.role='school_admin'；approver_assignments 提供
// 组长/专家身份（有生效任命即可审核，收件箱查询按 assigned_user_id 匹配任务，无需在此枚举）。
import { cache } from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"

// React cache：同一次请求内 layout 与 page 会各取一次上下文，包一层后只查一次
//（非 fetch 数据源不会自动去重，见 node_modules/next/dist/docs 缓存指南）。
export const getAuthContext = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user)
    return {
      user: null,
      profile: null,
      identity: null,
      isAdmin: false,
      isSchoolAdmin: false,
      isApprover: false,
      isTeacher: false,
      isPendingTeacher: false,
      isStudent: false,
      roles: [],
    }

  const { data: profile } = await supabase
    .from("profiles")
    .select("user_id, name, email, school_id, avatar_url, is_admin, identity")
    .eq("user_id", user.id)
    .maybeSingle()

  const [roleRes, assnRes] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", user.id),
    // 组长/专家身份只落在 approver_assignments（user_roles 不镜像），按生效任命判定入口
    supabase.from("approver_assignments").select("id").eq("user_id", user.id).eq("is_active", true).limit(1),
  ])
  const roles = (roleRes.data ?? []).map((r) => r.role)
  // 身份（0025）：学生 / 教师待审核 / 教师；历史行（缺列）按教师兼容
  const identity = profile?.identity ?? "teacher"
  return {
    user,
    profile: profile ?? null,
    identity,
    isAdmin: Boolean(profile?.is_admin),
    isSchoolAdmin: roles.includes("school_admin"),
    isApprover: Boolean(assnRes.data?.length),
    isTeacher: identity === "teacher" || Boolean(profile?.is_admin),
    isPendingTeacher: identity === "teacher_pending",
    isStudent: identity === "student",
    roles,
  }
})

// 受保护页/动作：未登录一律回登录页
export async function requireUser() {
  const ctx = await getAuthContext()
  if (!ctx.user) redirect("/login")
  return ctx
}
