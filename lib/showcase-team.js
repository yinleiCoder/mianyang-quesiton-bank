// 项目团队岗位（纯数据）。团队岗位不是系统角色，不参与题目/试卷审批。
export const SHOWCASE_TEAM = [
  {
    id: "pm",
    title: "项目经理",
    owner: "金子轩",
    tone: "sky",
    icon: "pm",
    duties: "需求 / 计划 / 验收 / 风险 / 交付",
    note: "对最终交付结果负责",
  },
  {
    id: "designer",
    title: "美工",
    owner: "金子轩",
    tone: "rose",
    icon: "designer",
    duties: "Figma 原型 / 设计系统 / 双端适配 / 走查",
    note: "与项目经理同一人",
  },
  {
    id: "flutter-dev",
    title: "Flutter + Supabase 开发",
    owner: "陈明霖",
    tone: "violet",
    icon: "flutter_dev",
    duties: "学生端 Windows / Android · 数据与 RPC 接入",
  },
  {
    id: "web-dev",
    title: "网站 Next.js 开发",
    owner: "赵文俊",
    tone: "violet",
    icon: "web_dev",
    duties: "教师 / 管理端 · App Router · 页面与业务逻辑",
  },
  {
    id: "qa",
    title: "自动化测试",
    owner: "DeepSeek Harness",
    tone: "emerald",
    icon: "qa",
    duties: "单元 / Widget / 集成测试 · 网页断言",
  },
  {
    id: "cicd",
    title: "CI/CD 运维",
    owner: "GitHub Actions",
    tone: "slate",
    icon: "cicd",
    duties: "tag → 双平台构建 → Release → OSS 镜像 → Sentry 符号",
  },
]

export const TEAM_PIPELINE = [
  "tag",
  "build-windows",
  "build-android",
  "GitHub Release",
  "OSS 镜像",
  "Sentry 符号",
]
