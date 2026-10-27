// Remotion 动画的尺寸、分镜与业务闭环数据（纯数据，不 import Remotion）。
export const VIDEO = {
  fps: 30,
  width: 1920,
  height: 1080,
  durationInFrames: 2160,
}

export const SHOWCASE_FONT =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif'

// 连续排列：最后一项 from + duration 必须等于 VIDEO.durationInFrames。
export const SCENES = [
  { id: "intro", label: "片头", from: 0, duration: 90 },
  { id: "architecture", label: "架构分层", from: 90, duration: 390 },
  { id: "roles", label: "角色层级", from: 480, duration: 420 },
  { id: "approval", label: "审批闭环", from: 900, duration: 420 },
  { id: "team", label: "项目团队", from: 1320, duration: 330 },
  { id: "business", label: "业务闭环", from: 1650, duration: 360 },
  { id: "outro", label: "片尾", from: 2010, duration: 150 },
]

export const BUSINESS_LOOP = [
  { id: "author", label: "教师出题", sub: "AI 解析辅助", icon: "teacher" },
  { id: "review", label: "两级审批", sub: "组长 → 市级专家", icon: "city_expert" },
  { id: "publish", label: "入库发布", sub: "全市共享", icon: "published" },
  { id: "paper", label: "组卷", sub: "协同组卷", icon: "web_dev" },
  { id: "exam", label: "考试", sub: "学生作答", icon: "student" },
  { id: "practice", label: "练习 / 讲评", sub: "学情与讲评", icon: "qa" },
  { id: "feedback", label: "反馈 / 改版", sub: "纠错与迭代", icon: "cicd" },
]
