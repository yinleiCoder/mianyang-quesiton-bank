// 阅卷工作台。权限与做题端一致：只有试卷作者、本校管理员、系统管理员能判
// （RLS 与 RPC 各拦一次，这里只是少给一个进不来的入口）。
import Link from "next/link"
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { AccessDenied } from "@/components/access-denied"
import { ExamGradingBoard } from "@/components/papers/exam-grading-board"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { ArrowLeftIcon } from "lucide-react"

export const metadata = { title: "阅卷" }

export default async function PaperGradingPage({ params }) {
  const { id } = await params
  await requireUser()
  const ctx = await getAuthContext()
  const supabase = await createClient()

  const { data: paper } = await supabase
    .from("papers")
    .select("id, current_published_version_id")
    .eq("id", id)
    .maybeSingle()
  if (!paper) {
    return <AccessDenied title="试卷不存在" description="它可能已被删除，或链接有误。" />
  }

  // 首屏队列走同一个 RPC：它自己会断言阅卷权限，无权限时抛出可读原因
  let queue = []
  let denied = null
  try {
    const { data, error } = await supabase.rpc("list_exam_attempts_for_paper", {
      p_paper_id: id,
      p_only_pending: true,
      p_limit: 100,
      p_offset: 0,
    })
    if (error) throw error
    queue = data?.attempts ?? []
  } catch (err) {
    denied = err?.message ?? "无法读取阅卷队列"
  }

  if (denied) {
    return (
      <div className="space-y-4">
        <AccessDenied title="不能阅卷" description={denied} />
        <Button variant="ghost" nativeButton={false} render={<Link href={`/papers/${id}`} />}>
          <ArrowLeftIcon className="size-4" /> 返回试卷详情
        </Button>
      </div>
    )
  }

  const { data: version } = await supabase
    .from("paper_versions")
    .select("title")
    .eq("id", paper.current_published_version_id)
    .maybeSingle()

  return (
    <div className="space-y-5">
      <PageHeader
        title="阅卷"
        description={
          <>
            逐题批改学生的作答。主观题按<strong>计分点</strong>给分——
            一道三空的填空题就是三个分数框，对两空给两空的分；
            客观题由服务端自动判分，这里可以复核推翻。
          </>
        }
      />
      <p className="text-sm text-muted-foreground">
        {version?.title ?? "（试卷）"}
        <span className="mx-2">·</span>
        <Link href={`/papers/${id}`} className="text-primary hover:underline">
          返回试卷详情
        </Link>
      </p>
      <ExamGradingBoard paperId={id} initialQueue={queue} />
    </div>
  )
}
