// 渲染检查页（fixture）：学习画像雷达图。
//
// ⚠ 只渲染三套写死的画像，不读数据库；生产环境 404。
import { notFound } from "next/navigation"
import { LearningProfileFixture } from "@/components/students/learning-profile-fixture"

export const metadata = { title: "学习画像夹具" }

export default function DevProfileRadarPage() {
  if (process.env.VERCEL_ENV === "production") notFound()

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">学习画像雷达图夹具</h1>
      <p className="text-sm text-muted-foreground">
        三套假数据：稳健型、冲刺型、新同学（数据不足不画雷达）。
        真实画像由 0128 的 student_learning_profile 生成；persona/summary 是规则拼装，不调大模型。
      </p>
      <LearningProfileFixture />
    </main>
  )
}
