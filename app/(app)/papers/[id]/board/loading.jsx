// 成绩页的路由级骨架：这一页要等两个 SECURITY DEFINER 的 RPC（榜单 + 逐题统计），
// 用页面形状的骨架顶上，别用 (app) 那条通用兜底（三块灰条看不出在等什么）。
import { SkeletonPage } from "@/components/ui/skeletons"

export default function BoardLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">成绩与分析加载中</span>
      <SkeletonPage tiles={0} blocks={[14, 60]} />
    </div>
  )
}
