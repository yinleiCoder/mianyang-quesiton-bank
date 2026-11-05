// 渲染检查页（fixture）：学情问数的意图结果与条形图。
//
// ⚠ 只渲染写死的结果，不读数据库；生产环境 404。
import { notFound } from "next/navigation"
import { AskDataFixture, AskPaperFixture } from "@/components/analytics/ask-data-fixture"

export const metadata = { title: "学情问数夹具" }

export default function DevAnalyticsIntentPage() {
  if (process.env.VERCEL_ENV === "production") notFound()

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">学情问数夹具</h1>
      <p className="text-sm text-muted-foreground">
        下面是一句“最近 30 天哪些知识点最弱”的假解析结果。模型只输出受控意图，
        数据来自 class_learning_report；不写 SQL、不改任何数据。
      </p>
      <AskDataFixture />
      <h2 className="pt-2 text-sm font-medium">试卷口径（试题正确率表）</h2>
      <AskPaperFixture />
    </main>
  )
}
