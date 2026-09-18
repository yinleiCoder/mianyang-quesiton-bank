// 路径 → 面包屑（纯数据 + 纯函数，客户端用）。
//
// 为什么是静态表而不是让页面各自声明：面包屑渲染在 (app) 布局的头部，
// 而布局不认识页面。让每个页面去 portal/context 里塞自己的标题，比维护这张表贵得多。
//
// 为什么详情页只显示"类型"（题目详情 / 审批详情）而不显示题干摘要：
// 摘要要布局再打一次库；面包屑的用途是「跳回上一层」，不是复述页面内容。
//
// 标签与侧栏导航（components/app-sidebar.jsx 的 useNavItems）保持一致 —— 改一处记得改另一处。

const C = (label, href) => (href ? { label, href } : { label })

const RULES = [
  { re: /^\/dashboard$/, crumbs: () => [C("工作台")] },
  { re: /^\/profile$/, crumbs: () => [C("个人资料")] },

  { re: /^\/questions$/, crumbs: () => [C("我的题目")] },
  { re: /^\/questions\/new$/, crumbs: () => [C("我的题目", "/questions"), C("出题")] },
  {
    re: /^\/questions\/import$/,
    crumbs: () => [C("我的题目", "/questions"), C("AI智能解析题库资料")],
  },
  // 详情页：前一节可点回列表，末一节是当前页
  {
    re: /^\/questions\/[^/]+\/edit$/,
    crumbs: () => [C("我的题目", "/questions"), C("编辑题目")],
  },
  {
    re: /^\/questions\/[^/]+\/revise$/,
    crumbs: () => [C("我的题目", "/questions"), C("发起改版")],
  },

  { re: /^\/bank$/, crumbs: () => [C("题库")] },
  { re: /^\/bank\/[^/]+$/, crumbs: () => [C("题库", "/bank"), C("题目详情")] },

  { re: /^\/papers$/, crumbs: () => [C("组卷库")] },
  { re: /^\/papers\/new$/, crumbs: () => [C("组卷库", "/papers"), C("新建试卷")] },
  { re: /^\/papers\/edit\/[^/]+$/, crumbs: () => [C("组卷库", "/papers"), C("组卷")] },
  { re: /^\/papers\/[^/]+\/grading$/, crumbs: () => [C("组卷库", "/papers"), C("阅卷")] },
  { re: /^\/papers\/[^/]+$/, crumbs: () => [C("组卷库", "/papers"), C("试卷详情")] },

  { re: /^\/review$/, crumbs: () => [C("审批收件箱")] },
  { re: /^\/review\/[^/]+$/, crumbs: () => [C("审批收件箱", "/review"), C("审批详情")] },

  // 学生名册。标签按角色变（侧栏 app-sidebar.jsx 同步），面包屑里取不了 ctx，
  // 所以用一个中性的「学生」——比按最常用的角色写死更不容易在换角色时读起来别扭。
  { re: /^\/students$/, crumbs: () => [C("学生")] },
  { re: /^\/students\/[^/]+$/, crumbs: () => [C("学生", "/students"), C("学生学情")] },

  // 管理台：侧栏里「管理台」是个分组标题、没有落地页，所以它只作纯文字前缀
  { re: /^\/admin\/schools$/, crumbs: () => [C("管理台"), C("学校管理")] },
  { re: /^\/admin\/tree$/, crumbs: () => [C("管理台"), C("科目树维护")] },
  { re: /^\/admin\/users$/, crumbs: () => [C("管理台"), C("用户与任命")] },
  { re: /^\/admin\/classes$/, crumbs: () => [C("管理台"), C("班级管理")] },
  { re: /^\/admin\/tags$/, crumbs: () => [C("管理台"), C("标签管理")] },
  { re: /^\/admin\/reviews$/, crumbs: () => [C("管理台"), C("审批记录")] },
  { re: /^\/admin\/audit$/, crumbs: () => [C("管理台"), C("审计日志")] },
  { re: /^\/admin\/feedback$/, crumbs: () => [C("管理台"), C("意见反馈")] },
]

// 命中的规则 → 面包屑数组；没命中返回 []（调用方给兜底展示）
export function trailOf(pathname) {
  const path = (pathname ?? "").replace(/\/+$/, "") || "/"
  return RULES.find((r) => r.re.test(path))?.crumbs() ?? []
}
