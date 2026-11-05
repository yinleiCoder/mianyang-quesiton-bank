// 渲染检查页（fixture）：逐题错因诊断。
//
// ⚠ 只渲染写死的诊断结果，不读数据库；生产环境 404。
import { notFound } from "next/navigation"
import { ErrorDiagnosisFixture } from "@/components/classes/error-diagnosis-fixture"

export const metadata = { title: "错因诊断夹具" }

export default function DevErrorDiagnosisPage() {
  if (process.env.VERCEL_ENV === "production") notFound()

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">逐题错因诊断夹具</h1>
      <p className="text-sm text-muted-foreground">
        下面是一份假的诊断结果：两道题、固定错因分类、证据引用原文、样本门槛与教学动作。
        真正的诊断会按班级作答数据生成，只给建议，不改成绩。
      </p>
      <ErrorDiagnosisFixture />
    </main>
  )
}
