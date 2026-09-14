// 人物资料聚合（服务端用）：uid 集合 → 资料快照（姓名/头像 key/邮箱/学校/在职角色/身份）。
// 角色口径与用户管理一致：profiles.is_admin=系统管理员；user_roles school_admin=学校管理员；
// approver_assignments is_active=教研组长/市级专家；无任何角色时按 identity 落身份标签。
// （0033 起本模块也服务于意见反馈收件箱，提交人多为学生——旧口径「无角色一律教师」会标错。）
// profiles.email 若被列级收紧导致查询失败，自动降级为不含邮箱重试。

const ROLE_LABELS = {
  school_admin: "学校管理员",
  city_expert: "市级专家",
  group_leader: "教研组长",
}
const ROLE_ORDER = ["school_admin", "city_expert", "group_leader"]

// identity 为 not null 三态（0025），文案与 app-sidebar 的身份标签一致
const IDENTITY_LABELS = {
  teacher: "教师",
  teacher_pending: "教师（待审核）",
  student: "学生",
}

export async function loadPeople(supabase, uids) {
  const ids = [...new Set((uids ?? []).filter(Boolean))]
  const out = new Map()
  if (ids.length === 0) return out

  let profiles = []
  let pRes = await supabase
    .from("profiles")
    .select("user_id, name, email, school_id, avatar_url, is_admin, identity")
    .in("user_id", ids)
  if (pRes.error) {
    pRes = await supabase
      .from("profiles")
      .select("user_id, name, school_id, avatar_url, is_admin, identity")
      .in("user_id", ids)
  }
  profiles = pRes.data ?? []

  const [rRes, aRes] = await Promise.all([
    supabase.from("user_roles").select("user_id, role").eq("role", "school_admin").in("user_id", ids),
    supabase
      .from("approver_assignments")
      .select("user_id, role")
      .eq("is_active", true)
      .in("user_id", ids),
  ])
  const elevated = [...(rRes.data ?? []), ...(aRes.data ?? [])]
  // 按 uid 归组：school_admin（user_roles）与生效任命（approver_assignments）并集
  const rolesByUid = new Map()
  for (const row of elevated) {
    if (!rolesByUid.has(row.user_id)) rolesByUid.set(row.user_id, [])
    rolesByUid.get(row.user_id).push(row.role)
  }

  const schoolIds = [...new Set(profiles.map((p) => p.school_id).filter(Boolean))]
  const schoolRes = schoolIds.length
    ? await supabase.from("schools").select("id, name").in("id", schoolIds)
    : { data: [] }
  const schoolNameOf = new Map((schoolRes.data ?? []).map((s) => [s.id, s.name]))

  for (const p of profiles) {
    const got = new Set()
    const list = []
    if (p.is_admin) {
      list.push("系统管理员")
      got.add("系统管理员")
    }
    for (const key of ROLE_ORDER) {
      if (!got.has(ROLE_LABELS[key]) && (rolesByUid.get(p.user_id) ?? []).includes(key)) {
        list.push(ROLE_LABELS[key])
        got.add(ROLE_LABELS[key])
      }
    }
    if (list.length === 0) list.push(IDENTITY_LABELS[p.identity] ?? "学生")
    out.set(p.user_id, {
      uid: p.user_id,
      name: p.name ?? "",
      email: p.email ?? "",
      avatarKey: p.avatar_url ?? "",
      schoolName: schoolNameOf.get(p.school_id) ?? "",
      roles: list,
    })
  }
  return out
}
