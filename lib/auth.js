// 鉴权 DAL：唯一入口拿"当前登录用户 + 档案 + 角色"，每个 Server Action / Route Handler / 页面自查。
// 依赖：profiles.school_id 档案；user_roles.role='school_admin'；approver_assignments 提供
// 组长/专家身份（有生效任命即可审核，收件箱查询按 assigned_user_ids 池匹配任务，无需在此枚举）。
import { cache } from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"

// 未登录 / 取不到上下文时的空档（下游只读字段，不写）
const EMPTY_AUTH = {
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

// React cache：同一次请求内 layout 与 page 会各取一次上下文，包一层后只查一次
//（非 fetch 数据源不会自动去重，见 node_modules/next/dist/docs 缓存指南）。
//
// 两次网络往返 → 零次 + 一次（原来 getUser → profiles → Promise.all(roles, assignments)
// 是 3 次串行，实测每跳 170–460ms，是每次页面加载的固定开销）：
//   1. getClaims() 本地验签，不发请求 —— 项目 JWT 是 ES256 + JWKS
//      （实测 auth/v1/.well-known/jwks.json 返回 EC P-256 且带 kid）。
//      副作用与 getUser() 一致：token 临近过期时仍会刷新并经 setAll 写回 cookie。
//      哪天改回 HS256 签发，SDK 会自动退化成 getUser()，最坏也只是回到原来的行为。
//   2. auth_context() 一次往返取回档案 + 角色 + 生效任命（见 0041）。
// 第 1 步：本地验签（0 网络往返）。同一次请求内 layout 与 page 共享，只验一次。
const getSessionClaims = cache(async () => {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  return data?.claims ?? null
})

export const getAuthContext = cache(async () => {
  const claims = await getSessionClaims()
  if (!claims?.sub) return { ...EMPTY_AUTH }

  // 第 2 步：档案 + 角色 + 任命，一次往返（见 0041）
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("auth_context")
  // 出错按未登录处理：requireUser() 会把人送去登录页，而不是让整站进错误边界。
  if (error || !data) return { ...EMPTY_AUTH }

  const profile = data.profile ?? null
  const roles = Array.isArray(data.roles) ? data.roles : []
  // 身份（0025）：学生 / 教师待审核 / 教师；历史行（缺列）按教师兼容
  const identity = profile?.identity ?? "teacher"
  return {
    // 下游只用到 .id 与 .email（全仓 grep 确认），不再透传整个 auth user 对象。
    // email 优先取 JWT claim（签发时的事实），取不到再退到 profiles.email —— 两个来源
    // 都在手边，兜一下免得某个签发路径不带 email 时页面上静默变成空白。
    user: { id: claims.sub, email: claims.email ?? profile?.email ?? "" },
    profile,
    identity,
    isAdmin: Boolean(profile?.is_admin),
    isSchoolAdmin: roles.includes("school_admin"),
    isApprover: Boolean(data.is_approver),
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

// 只要"登录了没"的闸门：不取档案，所以省掉了 auth_context 那一次往返。
// 给应用外壳用——先把 shell 刷出去、再让侧栏数据流式补上（见 app/(app)/layout.jsx）。
// 判定条件与 requireUser() 完全一致（两者都以 claims.sub 为准），
// 所以"谁会被踢去登录页"没有任何变化。
//
// 注意：getClaims() 本身是本地验签，但**冷实例上第一次**仍要拉一次 JWKS
//（SDK 内存缓存 10 分钟，之后就是纯本地）。比原先每请求一次 getUser() 仍是净赚。
export async function requireSession() {
  if (!(await getSessionClaims())) redirect("/login")
}
