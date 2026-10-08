// 班级学情的路由级骨架：这一页要等三条 RPC（练习学情 + 考试结果 + 名册），是三页里最慢的。
// 形状按真实版面走：一排数字块（参与度）+ 几块内容（考试卡片 / 知识点 / 预警 / 名册）。
import { SkeletonPage } from "@/components/ui/skeletons"

export default function ClassReportLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">班级学情加载中</span>
      <SkeletonPage tiles={4} blocks={[52, 40, 44]} />
    </div>
  )
}
