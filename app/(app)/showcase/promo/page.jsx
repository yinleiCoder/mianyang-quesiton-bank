// 软件宣传展示：Windows / Android 两条编程式宣传动画。
// 只读展示，不读业务数据、不接收用户输入；与「教学动画空间」无关。
import { requireUser } from "@/lib/auth"
import { PageHeader } from "@/components/page-header"
import { SoftwarePromoShowcase } from "@/components/showcase/promo/software-promo-showcase"

export const metadata = { title: "软件宣传展示" }

export default async function ShowcasePromoPage() {
  await requireUser()
  return (
    <div className="space-y-4">
      <PageHeader
        title="软件宣传展示"
        description="网页出题、软件刷题：教师在网页端用 AI 出题、两级审批、组卷、讲评；学生在 Windows / Android 刷题、考试、错题与复习。三条动画按真实使用流程编排。"
      />
      <SoftwarePromoShowcase />
    </div>
  )
}
