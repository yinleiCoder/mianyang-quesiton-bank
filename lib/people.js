// 人物资料聚合（服务端用）：uid 集合 → 资料快照（姓名/头像 key/邮箱/学校/在职角色/身份）。
// 角色口径与用户管理一致：profiles.is_admin=系统管理员；user_roles school_admin=学校管理员；
// approver_assignments is_active=教研组长/市级专家；无任何角色时按 identity 落身份标签。
// （0033 起本模块也服务于意见反馈收件箱，提交人多为学生——旧口径「无角色一律教师」会标错。）
// profiles.email 若被列级收紧导致查询失败，自动降级为不含邮箱重试。
//
// `schools` 可选传入：学校名单是全市共享的静态参考数据，服务端页面多半已经通过
// lib/reference-data 的 loadSchools() 拿到（缓存，零往返）。传进来就省掉这里的一次查询——
// 而这一层每次都为同样的 9 行打一次往返，是页面并发查询数里最没必要的一个。
// 本模块会被打进客户端（lib/feedback.js ← feedback-inbox.jsx），**不能自己 import
// lib/reference-data**（那个模块 import 了 next/cache），所以只能由调用方传进来。
import { ADMIN_LABEL, IDENTITY_LABELS, ROLE_LABELS } from "@/lib/roles"

// 展示顺序（组长/专家可能同挂一个节点，顺序固定就不受查询行序影响）
const ROLE_ORDER = ["school_admin", "city_expert", "group_leader"]

export async function loadPeople(supabase, uids, schools = null) {
  const ids = [...new Set((uids ?? []).filter(Boolean))]
  const out = new Map()
  if (ids.length === 0) return out

  // 三张表都以同一组 ids 为条件、彼此不依赖 —— 并进一个 Promise.all，
  // 少等一整轮往返。原先 profiles 先 await、再并行查另两张，是白白串行的。
  const [pResRaw, rRes, aRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("user_id, name, email, school_id, avatar_url, is_admin, identity")
      .in("user_id", ids),
    supabase.from("user_roles").select("user_id, role").eq("role", "school_admin").in("user_id", ids),
    supabase
      .from("approver_assignments")
      .select("user_id, role")
      .eq("is_active", true)
      .in("user_id", ids),
  ])
  // email 列可能被列级授权收紧（见文件头），只有这一支需要降级重查；
  // roles/assignments 的结果照常复用，不受影响。
  const pRes = pResRaw.error
    ? await supabase
        .from("profiles")
        .select("user_id, name, school_id, avatar_url, is_admin, identity")
        .in("user_id", ids)
    : pResRaw
  const profiles = pRes.data ?? []
  const elevated = [...(rRes.data ?? []), ...(aRes.data ?? [])]
  // 按 uid 归组：school_admin（user_roles）与生效任命（approver_assignments）并集
  const rolesByUid = new Map()
  for (const row of elevated) {
    if (!rolesByUid.has(row.user_id)) rolesByUid.set(row.user_id, [])
    rolesByUid.get(row.user_id).push(row.role)
  }

  let schoolNameOf
  if (schools) {
    // 调用方已经拿到（多半是缓存的）全量学校名单，直接用，一次往返都省掉
    schoolNameOf = new Map(schools.map((s) => [s.id, s.name]))
  } else {
    const schoolIds = [...new Set(profiles.map((p) => p.school_id).filter(Boolean))]
    const schoolRes = schoolIds.length
      ? await supabase.from("schools").select("id, name").in("id", schoolIds)
      : { data: [] }
    schoolNameOf = new Map((schoolRes.data ?? []).map((s) => [s.id, s.name]))
  }

  for (const p of profiles) {
    const got = new Set()
    const list = []
    if (p.is_admin) {
      list.push(ADMIN_LABEL)
      got.add(ADMIN_LABEL)
    }
    for (const key of ROLE_ORDER) {
      if (!got.has(ROLE_LABELS[key]) && (rolesByUid.get(p.user_id) ?? []).includes(key)) {
        list.push(ROLE_LABELS[key])
        got.add(ROLE_LABELS[key])
      }
    }
    if (list.length === 0) {
      list.push(IDENTITY_LABELS[p.identity] ?? IDENTITY_LABELS.student)
    }
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
