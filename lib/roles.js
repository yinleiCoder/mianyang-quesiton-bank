// 角色 / 身份文案的唯一来源：纯数据 + 纯函数，服务端与客户端共用（无 "use server"）。
// 口径与用户管理、题库作者 chips 一致（见 lib/people.js）：
//   profiles.is_admin = 系统管理员；user_roles school_admin = 学校管理员；
//   approver_assignments is_active = 教研组长 / 市级专家；以上都没有则按 identity 落身份标签（0025 三态）。
// 注意：auth_context() 只回 is_approver 布尔值、不枚举任命角色，所以「当前用户」一侧
// 取不到组长 / 专家具体角色 —— ownRoleLabels() 就是按这个信息量写的，别在这里猜。

export const ROLE_LABELS = {
  school_admin: "学校管理员",
  group_leader: "教研组长",
  city_expert: "市级专家",
}

export const IDENTITY_LABELS = {
  teacher: "教师",
  teacher_pending: "教师（待审核）",
  student: "学生",
}

// profiles.is_admin 不是 user_roles 里的一行，文案单独放
export const ADMIN_LABEL = "系统管理员"

// 当前登录用户的展示用标签（侧栏副标题 / 用户菜单 / 个人资料页三处共用）。
// 有管理角色时只列管理角色，否则退回身份标签 —— 沿用侧栏副标题的历史口径；
// identity 缺省按教师兜底（历史行，与 lib/auth.js 的 identity 缺省一致）。
export function ownRoleLabels({ isAdmin, isSchoolAdmin, identity }) {
  const labels = []
  if (isAdmin) labels.push(ADMIN_LABEL)
  if (isSchoolAdmin) labels.push(ROLE_LABELS.school_admin)
  if (labels.length === 0) {
    labels.push(IDENTITY_LABELS[identity] ?? IDENTITY_LABELS.teacher)
  }
  return labels
}
