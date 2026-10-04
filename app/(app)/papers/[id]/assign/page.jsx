// 协同组卷 · 创始人面板（0085）：划子卷任务 + 合卷视图。
//
// 只有**创始人**（papers.creator_id）进得来，且卷子必须还在 draft/returned ——
// 与服务端那几个 RPC 的守卫同一条口径（这里拦一道是为了给一句人话，不是安全边界）。
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperVersion, loadPaperAssignCandidates } from "@/lib/paper-workbench"
import { loadPaperAssignments } from "@/lib/paper-assignments"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { PaperAssignPanel } from "@/components/papers/paper-assign-panel"
import Link from "next/link"

export const metadata = { title: "协作分派" }

export default async function PaperAssignPage({ params }) {
  const { id } = await params
  await requireUser()
  const ctx = await getAuthContext()
  const supabase = await createClient()

  const { data: paper, error: paperError } = await supabase
    .from("papers")
    .select("id, creator_id, state, current_published_version_id")
    .eq("id", id)
    .maybeSingle()
  if (paperError) throw paperError
  if (!paper) {
    return <AccessDenied title="试卷不存在" description="它可能已被删除，或链接有误。" />
  }
  if (paper.creator_id !== ctx.user?.id) {
    return (
      <AccessDenied
        title="只有创始人能分派"
        description="协作分派是把你的子卷任务分出去 —— 这份卷不是你建的。"
      />
    )
  }

  // 分派挂在**草稿/被退回的那一版**上。已入库的卷子要改版后才能再协作（且分派不跨版本）。
  const { data: version, error: versionError } = await supabase
    .from("paper_versions")
    .select("id, status, version_no")
    .eq("paper_id", id)
    .in("status", ["draft", "returned"])
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (versionError) throw versionError
  if (!version) {
    return (
      <AccessDenied
        title="当前没有可协作的草稿"
        description="协作分派只针对在编辑中的那一版（草稿或被退回）。已入库的卷子请先发起改版。"
      />
    )
  }

  const [snapshot, assignmentsRes, candidatesRes] = await Promise.all([
    loadPaperVersion(supabase, version.id),
    loadPaperAssignments(supabase, version.id),
    loadPaperAssignCandidates(supabase, { excludeUserId: ctx.user.id }),
  ])
  if (assignmentsRes.error) throw assignmentsRes.error
  if (candidatesRes.error) throw candidatesRes.error

  return (
    <div className="space-y-4">
      <PageHeader
        title="协作分派"
        description="把这份卷的子卷任务分给其他老师：选大题、圈题号区间、写目标分。他们只会看到并编辑自己那几段。"
      />
      <p className="text-sm text-muted-foreground">
        {snapshot.title} · 第 {version.version_no} 版 ·{" "}
        <Link href={`/papers/${id}`} className="underline underline-offset-2 hover:text-foreground">
          回试卷详情
        </Link>
      </p>
      <PaperAssignPanel
        versionId={version.id}
        sections={snapshot.sections ?? []}
        candidates={candidatesRes.candidates}
        assignments={assignmentsRes.assignments}
      />
    </div>
  )
}
