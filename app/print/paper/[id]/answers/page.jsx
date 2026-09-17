// 参考答案与评分标准打印页。独立路由，原因见正卷页顶部注释（安全边界，不是排版偏好）。
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperVersion } from "@/lib/paper-workbench"
import { PaperSheet } from "@/components/papers/paper-sheet"
import { PrintButton } from "@/components/print-button"
import { AccessDenied } from "@/components/access-denied"
import { Button } from "@/components/ui/button"

export const metadata = { title: "打印参考答案" }

export default async function PrintPaperAnswersPage({ params }) {
  const { id } = await params
  await requireUser()
  const supabase = await createClient()

  let snapshot = null
  try {
    snapshot = await loadPaperVersion(supabase, id)
  } catch {
    snapshot = null
  }
  if (!snapshot) {
    return (
      <AccessDenied
        title="试卷不可见"
        description="这份试卷可能正在审核中、已被撤回，或不属于你，因此不能打印。"
      />
    )
  }

  return (
    <div className="mx-auto max-w-[820px] bg-white p-8 text-black print:p-0">
      <div className="mb-6 flex flex-wrap items-center gap-3 print:hidden">
        <PrintButton hint="含答案与解析，注意别发给学生" />
        <Button variant="outline" nativeButton={false} render={<Link href={`/print/paper/${id}`} />}>
          打印正卷（不含答案）
        </Button>
      </div>

      <div className="mb-4 border-b-2 border-black/60 pb-2">
        <h1 className="text-lg font-semibold">参考答案与评分标准</h1>
        <p className="mt-1 text-sm">
          {snapshot.title}
          {snapshot.exam_name ? ` · ${snapshot.exam_name}` : ""}
        </p>
      </div>

      <PaperSheet snapshot={snapshot} mode="answers" />
    </div>
  )
}
