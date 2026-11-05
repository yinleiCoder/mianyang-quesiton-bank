"use client"

// 学习画像雷达图的懒加载外壳。理由同 dashboard 的学校贡献图：
// recharts 是本站最大的单块依赖，静态导入约 366KB；ssr:false 只在客户端组件里生效。
import dynamic from "next/dynamic"

export const LearningProfileChart = dynamic(
  () =>
    import("@/components/students/learning-profile-chart").then(
      (m) => m.LearningProfileChart
    ),
  {
    ssr: false,
    loading: () => <div className="h-72 w-full animate-pulse rounded-lg bg-muted" />,
  }
)
