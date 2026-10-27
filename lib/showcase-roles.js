// 人员层级图数据（纯数据）。角色文案复用 lib/roles.js，避免与用户管理/侧栏漂移。
// 关键事实：教研组长 key 是 group_leader（不存在 subject_lead）；
// 系统管理员是 profiles.is_admin 布尔，不是 user_roles 的一行。
import { ADMIN_LABEL, IDENTITY_LABELS, ROLE_LABELS } from "./roles"

export const ROLE_LAYOUT = {
  width: 1200,
  systemHeight: 830,
  teamY: 870,
  teamHeight: 340,
  roleW: 236,
  teamW: 220,
}

export const ROLE_LANES = [
  {
    id: "system",
    title: "系统角色（平台内）",
    subtitle: "任命关系 + 两级审批链；市由学校推导",
    tone: "violet",
  },
  {
    id: "team",
    title: "项目团队（研发交付）",
    subtitle: "团队岗位不是系统角色，不参与审批",
    tone: "slate",
  },
]

export const SHOWCASE_ROLES = [
  {
    id: "system_admin",
    title: ADMIN_LABEL,
    tone: "rose",
    icon: "system_admin",
    scope: "全平台 · 唯一",
    duties: "市 / 学校 / 科目树 / 知识点 / 审批记录 / 审计 / 反馈",
    appoints: "任命学校管理员、市级专家",
    limit: "不能任命教研组长",
  },
  {
    id: "school_admin",
    title: ROLE_LABELS.school_admin,
    tone: "violet",
    icon: "school_admin",
    scope: "本校",
    duties: "本校用户、班级、题目反馈兜底、教师身份审核",
    appoints: "任命本校教研组长",
    limit: "不能任命市级专家",
  },
  {
    id: "group_leader",
    title: ROLE_LABELS.group_leader,
    tone: "amber",
    icon: "group_leader",
    scope: "本校 + 科目节点子树 · 一岗一人",
    duties: "审批 stage=group；本校范围内的题目 / 试卷",
    limit: "由学校管理员任命",
  },
  {
    id: "city_expert",
    title: ROLE_LABELS.city_expert,
    tone: "emerald",
    icon: "city_expert",
    scope: "本市 + 科目节点子树 · 岗位池",
    duties: "审批 stage=city；池内任一人处理，谁先处理算谁的",
    limit: "由系统管理员任命",
  },
  {
    id: "teacher",
    title: IDENTITY_LABELS.teacher,
    tone: "sky",
    icon: "teacher",
    scope: "本人 / 本校",
    duties: "出题、AI 解析、组卷、上传复习资料",
    limit: "教师（待审核）无出题权",
  },
  {
    id: "student",
    title: IDENTITY_LABELS.student,
    tone: "slate",
    icon: "student",
    scope: "本人 / 班级",
    duties: "看题库 / 组卷库 / 资料、下载客户端、纠错反馈",
    limit: "不能被任命为任何审核岗位",
  },
]

export const PUBLISHED_NODE = {
  id: "published",
  title: "入库发布",
  tone: "emerald",
  icon: "published",
  scope: "版本发布 · 全市可见",
  duties: "旧版本置为 superseded；current_published_version_id 切换",
  limit: "须经两级审批（特殊规则除外）",
}

export const ROLE_POSITIONS = {
  system_admin: { x: 482, y: 40 },
  school_admin: { x: 160, y: 190 },
  city_expert: { x: 800, y: 190 },
  group_leader: { x: 160, y: 350 },
  teacher: { x: 160, y: 520 },
  student: { x: 160, y: 680 },
  published: { x: 800, y: 350 },
  pm: { x: 480, y: 910 },
  designer: { x: 20, y: 1070 },
  "flutter-dev": { x: 260, y: 1070 },
  "web-dev": { x: 500, y: 1070 },
  qa: { x: 740, y: 1070 },
  cicd: { x: 980, y: 1070 },
}

export const ROLE_EDGES = [
  {
    id: "r-admin-school", source: "system_admin", target: "school_admin",
    label: "任命", tone: "violet", sourceHandle: "bs", targetHandle: "t",
  },
  {
    id: "r-admin-city", source: "system_admin", target: "city_expert",
    label: "任命 · 岗位池", tone: "violet", sourceHandle: "bs", targetHandle: "t",
  },
  {
    id: "r-school-group", source: "school_admin", target: "group_leader",
    label: "任命 · 一岗一人", tone: "violet", sourceHandle: "bs", targetHandle: "t",
  },
  {
    id: "r-teacher-group", source: "teacher", target: "group_leader",
    label: "提交 · stage=group", tone: "amber", sourceHandle: "ts", targetHandle: "b",
  },
  {
    id: "r-group-city", source: "group_leader", target: "city_expert",
    label: "通过 · stage=city", tone: "amber", sourceHandle: "ts", targetHandle: "b",
  },
  {
    id: "r-city-published", source: "city_expert", target: "published",
    label: "入库发布", tone: "emerald", sourceHandle: "bs", targetHandle: "t",
  },
  {
    id: "r-teacher-city", source: "teacher", target: "city_expert",
    label: "唯一组长本人提交时跳过 group", tone: "slate",
    animated: false, dashed: true, sourceHandle: "rs", targetHandle: "r",
  },
  {
    id: "r-teacher-student", source: "teacher", target: "student",
    label: "教学 / 学情", tone: "sky", sourceHandle: "bs", targetHandle: "t",
  },
]

export const TEAM_EDGES = ["designer", "flutter-dev", "web-dev", "qa", "cicd"].map((id) => ({
  id: `team-${id}`,
  source: "pm",
  target: id,
  label: "",
  tone: "slate",
  animated: false,
  dashed: true,
  sourceHandle: "bs",
  targetHandle: "t",
}))
