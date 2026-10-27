// 软件架构图的节点与边（纯数据，不 import React / lucide / @xyflow/react）。
// 布局是手动坐标 + 横向泳道：仓库没有 dagre/elk，两张图都刻意不引布局库。
export const ARCH_LAYOUT = {
  laneW: 1200,
  laneH: 210,
  laneGap: 24,
  nodeX0: 30,
  nodeY0: 66,
  colGap: 290,
  nodeW: 240,
}

export const ARCH_LANES = [
  { id: "clients", title: "用户端", subtitle: "教师浏览器 / Windows / Android", tone: "sky" },
  { id: "edge", title: "入口与外部", subtitle: "Cloudflare / Worker / DeepSeek", tone: "amber" },
  { id: "apps", title: "应用层", subtitle: "Next.js / Flutter", tone: "violet" },
  { id: "data", title: "数据与存储", subtitle: "Supabase / 阿里云 OSS", tone: "emerald" },
  { id: "delivery", title: "交付与观测", subtitle: "Vercel / GitHub Actions / Sentry", tone: "slate" },
]

const N = (id, lane, col, title, subtitle, icon, tone, extra = {}) => ({
  id, lane, col, title, subtitle, icon, tone, ...extra,
})

export const ARCH_NODES = [
  N("teacher-web", "clients", 0, "教师 / 管理端浏览器", "Chrome / Edge · myquiz.cn", "browser", "sky"),
  N("windows", "clients", 1, "Windows 学生端", "Flutter 打包 · 安装包走 OSS", "windows", "sky"),
  N("android", "clients", 2, "Android 学生端", "Flutter 打包 · APK 走阿里云 OSS", "android", "sky"),

  N("cloudflare", "edge", 0, "Cloudflare", "myquiz.cn · DNS / 防护", "cloudflare", "amber"),
  N("worker", "edge", 1, "Cloudflare Worker", "supabase-proxy · api.myquiz.cn 反代", "worker", "amber", {
    badges: ["不缓存", "不鉴权", "不代理 OSS"],
  }),
  N("deepseek", "edge", 2, "DeepSeek", "教师自带 key · 浏览器直连", "deepseek", "rose"),

  N("nextjs", "apps", 1, "Next.js 16", "教师 / 管理端 · App Router", "nextjs", "violet", {
    badges: ["RSC", "proxy 乐观鉴权"],
  }),
  N("flutter", "apps", 2, "Flutter", "一套代码 · Windows + Android", "flutter", "violet", {
    badges: ["sentry_flutter 10.x"],
  }),

  N("supabase", "data", 1, "Supabase", "PostgreSQL + Auth + PostgREST + RPC", "supabase", "emerald", {
    badges: ["RLS", "SECURITY DEFINER", "媒体走 OSS"],
  }),
  N("oss", "data", 2, "阿里云 OSS（成都）", "qbank / avatars / materials / client · 单份 2GB", "oss", "emerald", {
    badges: ["签名 URL", "Windows + APK"],
  }),

  N("vercel", "delivery", 0, "Vercel", "网页托管 · hkg1 · push 即构建", "vercel", "slate"),
  N("actions", "delivery", 1, "GitHub Actions", "release.yml · tag 触发双平台构建", "actions", "slate"),
  N("release", "delivery", 2, "GitHub Release", "构建产物 · 镜像到阿里云 OSS", "release", "slate"),
  N("sentry", "delivery", 3, "Sentry", "仅 Flutter 接入 · 网页端未接入", "sentry", "rose"),
]

const E = (id, source, target, label, tone, extra = {}) => ({
  id, source, target, label, tone, animated: true, ...extra,
})

export const ARCH_EDGES = [
  E("e-web-cf", "teacher-web", "cloudflare", "myquiz.cn", "sky", { sourceHandle: "bs", targetHandle: "t" }),
  E("e-web-worker", "teacher-web", "worker", "API 请求", "sky", { sourceHandle: "rs", targetHandle: "l" }),
  E("e-cf-worker", "cloudflare", "worker", "api.myquiz.cn", "amber", { sourceHandle: "rs", targetHandle: "l" }),
  E("e-cf-vercel", "cloudflare", "vercel", "A 记录（灰云）", "amber", { sourceHandle: "bs", targetHandle: "t" }),
  E("e-vercel-next", "vercel", "nextjs", "托管 / 部署", "slate", { sourceHandle: "rs", targetHandle: "l" }),
  E("e-win-worker", "windows", "worker", "Supabase SDK", "sky", { sourceHandle: "bs", targetHandle: "t" }),
  E("e-android-worker", "android", "worker", "Supabase SDK", "sky", { sourceHandle: "ls", targetHandle: "r" }),
  E("e-next-worker", "nextjs", "worker", "服务端 / 浏览器请求", "violet", { sourceHandle: "ts", targetHandle: "b" }),
  E("e-worker-sb", "worker", "supabase", "反代透传", "amber", { sourceHandle: "bs", targetHandle: "t" }),
  E("e-flutter-win", "flutter", "windows", "同一套代码构建", "violet", { sourceHandle: "ls", targetHandle: "r", pathKind: "bezier" }),
  E("e-flutter-android", "flutter", "android", "同一套代码构建", "violet", { sourceHandle: "rs", targetHandle: "r", pathKind: "bezier" }),
  E("e-next-oss", "nextjs", "oss", "签名 URL · 媒体", "emerald", { sourceHandle: "rs", targetHandle: "l" }),
  E("e-flutter-oss", "flutter", "oss", "资料 / 安装包", "emerald", { sourceHandle: "bs", targetHandle: "t" }),
  E("e-flutter-sentry", "flutter", "sentry", "异常上报", "rose", { sourceHandle: "rs", targetHandle: "l" }),
  E("e-actions-release", "actions", "release", "tag 触发", "slate", { sourceHandle: "rs", targetHandle: "l" }),
  E("e-release-oss", "release", "oss", "镜像到 OSS", "slate", { sourceHandle: "ts", targetHandle: "b" }),
  E("e-actions-sentry", "actions", "sentry", "上传符号", "slate", { sourceHandle: "ts", targetHandle: "t", pathKind: "bezier" }),
  E("e-oss-windows", "oss", "windows", "setup.exe / zip", "emerald", { sourceHandle: "ls", targetHandle: "l" }),
  E("e-oss-android", "oss", "android", "APK（OSS）", "emerald", { sourceHandle: "rs", targetHandle: "r" }),
  E("e-web-deepseek", "teacher-web", "deepseek", "自带 key 直连", "rose", {
    animated: false, dashed: true, sourceHandle: "rs", targetHandle: "l", pathKind: "bezier",
  }),
]

export function archNodePosition(node) {
  const laneIndex = ARCH_LANES.findIndex((lane) => lane.id === node.lane)
  return {
    x: ARCH_LAYOUT.nodeX0 + node.col * ARCH_LAYOUT.colGap,
    y: laneIndex * (ARCH_LAYOUT.laneH + ARCH_LAYOUT.laneGap) + ARCH_LAYOUT.nodeY0,
  }
}

export function archLanePosition(index) {
  return { x: 0, y: index * (ARCH_LAYOUT.laneH + ARCH_LAYOUT.laneGap) }
}
