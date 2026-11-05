// 渲染检查页（fixture）：一句话组卷的“我理解成了”卡片。
//
// ⚠ 只渲染写死的意图，不读数据库；生产环境 404。
//   解析按钮在有密钥时会真调模型，卡片本身始终是假数据。
import { notFound } from "next/navigation"
import { PaperIntentFixture } from "@/components/papers/paper-intent-fixture"

export const metadata = { title: "一句话组卷夹具" }

export default function DevPaperIntentPage() {
  if (process.env.VERCEL_ENV === "production") notFound()

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">一句话组卷夹具</h1>
      <p className="text-sm text-muted-foreground">
        下面是一句“90 分、基础 60%、中档 30%、难 10%、第三章为主”的假解析结果。
        AI 只把它转成约束；选题仍由本地优化器完成。套用只改表单，不会自动生成或保存。
      </p>
      <PaperIntentFixture />
    </main>
  )
}
