// 用户与任命页的数据装载（服务端 SSR seed 与客户端操作后重查共用，保证两处口径一致）。
// 范围：系统管理员 = 全校用户 + 全量生效任命；学校管理员 = 本校用户 + 本校组长任命 + 全市专家任命
//（专家任命用于识别本校市级专家——其账号仅系统管理员可删，需要展示与禁用依据）。
// 各字段返回查询原始 data（失败为 null），由调用方决定兜底或保留旧值。
//
// **本页不含学生**（0063）：identity='student' 归 /students（lib/students.js），
// 两边互补且互斥 —— 学生转教师后自动换边。别在这里加"顺便也查学生"的兜底。
import { subjectNodesQuery } from "@/lib/subject-nodes"

// avatar_url 是 OSS 相对 key（avatars/…），展示端用 avatarUrl() 拼域名；名单表要显示头像，
// 少了这一列前端只能退回姓名首字占位（曾经就是如此）。
// major_node_id / major_category / major 是 0063 加的教师任教专业（学校管理员据此限定教师可见的学生）。
// phone 与 email 是两个独立字段（0064）：手机号账号的 email 存的是合成地址
// `138…@phone.myquiz.cn`，展示前要用 lib/phone.js 的 displayEmail/displayIdentifier 折叠掉。
export const PROFILE_COLUMNS =
  "user_id, name, email, phone, school_id, is_admin, identity, avatar_url, created_at, major_node_id, major_category, major"
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

  const profilesQuery = supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .neq("identity", "student")
    .order("created_at")
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
