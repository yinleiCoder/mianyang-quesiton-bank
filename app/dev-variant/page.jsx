// 渲染检查页（fixture）：AI 变式题的结果卡片。
//
// ⚠ 只渲染写死的变式结果，不读数据库；生产环境 404。
//   生成按钮在有密钥时会真调模型；卡片本身始终是假数据。
import { notFound } from "next/navigation"
import { VariantFixture } from "@/components/questions/variant-fixture"

export const metadata = { title: "AI 变式题夹具" }

export default function DevVariantPage() {
  if (process.env.VERCEL_ENV === "production") notFound()

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">AI 变式题夹具</h1>
      <p className="text-sm text-muted-foreground">
        下面是一道原题与两份假的变式结果：一份通过规则检查但难度有提示，一份题型不一致被拒绝。
        生成结果只存草稿，永不自动发布。
      </p>
      <VariantFixture />
    </main>
  )
}
