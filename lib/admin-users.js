// 用户与任命页的数据装载（服务端 SSR seed 与客户端操作后重查共用，保证两处口径一致）。
// 范围：系统管理员 = 全校用户 + 全量生效任命；学校管理员 = 本校用户 + 本校组长任命 + 全市专家任命
//（专家任命用于识别本校市级专家——其账号仅系统管理员可删，需要展示与禁用依据）。
// 各字段返回查询原始 data（失败为 null），由调用方决定兜底或保留旧值。
import { subjectNodesQuery } from "@/lib/subject-nodes"

export const PROFILE_COLUMNS = "user_id, name, email, school_id, is_admin, identity, created_at"
export const APPROVER_ASSIGNMENT_COLUMNS = "id, user_id, role, school_id, node_id, is_active"

export async function loadAdminUserDirectory(supabase, { isAdmin, schoolId = null }) {
  const scoped = !isAdmin && Boolean(schoolId)

  const baseAssign = () =>
    supabase.from("approver_assignments").select(APPROVER_ASSIGNMENT_COLUMNS).eq("is_active", true)
  const assignmentsQuery = scoped
    ? Promise.all([
        baseAssign().eq("school_id", schoolId).eq("role", "group_leader"),
        baseAssign().eq("role", "city_expert"),
      ]).then(([leaders, experts]) => [...(leaders.data ?? []), ...(experts.data ?? [])])
    : baseAssign().then((r) => r.data ?? [])

  const profilesQuery = supabase.from("profiles").select(PROFILE_COLUMNS).order("created_at")
  const [profiles, schools, roleRows, assignments, nodes] = await Promise.all([
    scoped ? profilesQuery.eq("school_id", schoolId) : profilesQuery,
    supabase.from("schools").select("id, name, is_active").order("name"),
    supabase.from("user_roles").select("user_id, role"),
    assignmentsQuery,
    subjectNodesQuery(supabase),
  ])

  return {
    profiles: profiles.data,
    schools: schools.data,
    roleRows: roleRows.data,
    assignments,
    nodes: nodes.data,
  }
}
