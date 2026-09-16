"use client"

// 学校贡献图表的懒加载外壳（Vercel React 最佳实践 bundle-dynamic-imports，CRITICAL）。
//
// 为什么要有这一层：recharts 是本站最大的单块依赖，静态导入约 366KB，
// 而它只服务这一张图 —— 却挂在登录后落地页的首屏包里（/dashboard 首屏 JS 因此到 1.4MB）。
//
// 为什么本文件必须是客户端组件：Next 文档写明两件事——
//   1. 「Server Component 动态导入 Client Component 时不支持自动分包」；
//   2. 「ssr: false 只在客户端组件里生效，要放进客户端组件才能正确分包」。
// 所以由服务端的卡片渲染本文件，本文件再 dynamic() 真正的图表模块。
//
// ssr: false 的代价与取舍：图表不再参与服务端渲染，改为水合后拉取该分块再画。
// 换来的是首屏 JS 少 366KB（水合更快、可交互更早）。图表占位块按 h-72 预留，
// 与真实图表等高，分块到达时不会造成布局跳动（CLS）。
import dynamic from "next/dynamic"

export const SchoolContributionChart = dynamic(
  () =>
    import("@/components/dashboard/school-contribution-chart").then(
      (m) => m.SchoolContributionChart
    ),
  {
    ssr: false,
    loading: () => <div className="h-72 w-full animate-pulse rounded-lg bg-muted" />,
  }
)
