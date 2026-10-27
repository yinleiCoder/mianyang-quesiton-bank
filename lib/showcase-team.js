// 项目团队岗位（纯数据）。团队岗位不是系统角色，不参与题目/试卷审批。
// 口径来自 docs/移动软件开发/四川省职业院校技能大赛（2026）.md 的「组员分工」。
export const SHOWCASE_TEAM = [
  {
    id: "pm",
    title: "项目经理",
    owner: "金子轩",
    tone: "sky",
    icon: "pm",
    duties: "客户沟通 / 需求文档 / 计划 / 协调 / 验收 / 按期交付",
    note: "对最终交付结果负责",
  },
  {
    id: "designer",
    title: "美工",
    owner: "金子轩",
    tone: "rose",
    icon: "designer",
    duties: "需求转设计 / Figma 原型 / 设计系统 / 双端适配 / 走查",
    note: "与项目经理同一人",
  },
  {
    id: "flutter-dev",
    title: "Flutter + Supabase 开发",
    owner: "陈明霖",
    tone: "violet",
    icon: "flutter_dev",
    duties: "Flutter Windows / Android 客户端；Supabase 数据表、权限、业务函数",
  },
  {
    id: "web-dev",
    title: "网站 Next.js 开发",
    owner: "赵文俊",
    tone: "violet",
    icon: "web_dev",
    duties: "教师 / 管理端页面与业务逻辑；AI 导入、审批、组卷打印",
  },
  {
    id: "qa",
    title: "自动化测试",
    owner: "DeepSeek Harness",
    tone: "emerald",
    icon: "qa",
    duties: "发布前找 Bug；单元 / Widget / 集成测试 + 回归",
  },
  {
    id: "cicd",
    title: "CI/CD 运维",
    owner: "GitHub Actions",
    tone: "slate",
    icon: "cicd",
    duties: "测试通过后持续集成 / 交付 / 运维；tag → 构建签名 → Release → OSS → Sentry",
  },
]

// 企业真实开发流程：原型设计 → 界面实现 → 功能开发 → 自动化测试 → CI/CD 发布。
// 项目经理与美工在第一步；开发按界面/功能分两段；测试通过后才进入发布。
export const TEAM_FLOW = [
  {
    id: "plan",
    stage: "01",
    title: "需求与原型",
    tone: "sky",
    icon: "pm",
    owners: ["项目经理 · 金子轩", "美工 · 金子轩"],
    bullets: ["客户沟通 / 需求文档", "Figma 原型 / 设计系统", "双端画板 390×844 / 1280×800"],
  },
  {
    id: "ui",
    stage: "02",
    title: "界面实现",
    tone: "violet",
    icon: "flutter_dev",
    owners: ["Flutter · 陈明霖", "网站 · 赵文俊"],
    bullets: ["按设计稿 1:1 还原", "Windows / Android 双端", "教师 / 管理端页面"],
  },
  {
    id: "feature",
    stage: "03",
    title: "功能开发",
    tone: "amber",
    icon: "web_dev",
    owners: ["Flutter + Supabase · 陈明霖", "网站 · 赵文俊"],
    bullets: ["登录注册 / 做题判分", "组卷考试 / 排行榜", "Supabase 数据表、权限、业务函数"],
  },
  {
    id: "test",
    stage: "04",
    title: "自动化测试",
    tone: "emerald",
    icon: "qa",
    owners: ["DeepSeek Harness"],
    bullets: ["单元 / Widget / 集成", "网页断言 + 浏览器自动化", "发布前回归"],
  },
  {
    id: "release",
    stage: "05",
    title: "CI/CD 运维",
    tone: "slate",
    icon: "cicd",
    owners: ["GitHub Actions"],
    bullets: ["tag → 双平台构建", "签名 / Release / OSS 镜像", "Sentry 符号与线上监控"],
  },
]

export const TEAM_NOTE =
  "项目经理对最终交付负责：需求、范围、计划、协作、质量、风险、交付、复盘。"

export const TEAM_PIPELINE = [
  "tag",
  "build-windows",
  "build-android",
  "GitHub Release",
  "OSS 镜像",
  "Sentry 符号",
]
