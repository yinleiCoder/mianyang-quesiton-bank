// 协同组卷 · 被指派人的片段编辑器（0085）。
//
// 只服务**被指派人本人**：分派那一段（大题序号 + 段内第 X~Y 题）里的题由他挑，
// 别人的题只作为上下文显示。创始人要看进度请走 /papers/[id]/assign。
//
// 题号是**绝对**的（大题内部第 X~Y 题）——摆位由 buildSegmentView 负责，
// 它的注释里写了为什么不能直接渲染"我的题"。
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperVersion } from "@/lib/paper-workbench"
import { loadSubjectNodes } from "@/lib/reference-data"
import { buildSegmentView, loadItemOwnership, loadPaperAssignments } from "@/lib/paper-assignments"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { SegmentEditor } from "@/components/papers/segment-editor"
import Link from "next/link"

export const metadata = { title: "子卷任务" }

export default async function PaperSegmentPage({ params }) {
  const { assignmentId } = await params
  await requireUser()
  const ctx = await getAuthContext()
  const supabase = await createClient()

  // RLS 已经只放行「我的 / 我发起的 / 管理员」，这里再判一次是不是**我自己的**
  const { data: row, error } = await supabase
    .from("paper_assignments")
    .select("id, version_id, section_ord, from_qno, to_qno, score, state, assignee_id, note")
    .eq("id", assignmentId)
    .maybeSingle()
  if (error) throw error
  if (!row || row.assignee_id !== ctx.user?.id) {
    return (
      <AccessDenied
        title="任务不存在或不属于你"
        description="这一段可能已经收回、换人，或者链接有误。"
      />
    )
  }

  const [snapshot, ownershipRes, assignmentsRes, nodes] = await Promise.all([
    loadPaperVersion(supabase, row.version_id),
    loadItemOwnership(supabase, row.version_id),
    loadPaperAssignments(supabase, row.version_id),
    loadSubjectNodes(),
  ])
  if (ownershipRes.error) throw ownershipRes.error

  // 带段级 token 的那一份（updated_us 由服务端算，别拿 JS 从时间戳反推）
  const meta = assignmentsRes.assignments.find((a) => a.id === row.id)
  if (!meta) {
    return (
      <AccessDenied
        title="这一段已经收回"
        description="创始人把这段收回去了，卷面上已挑的题归还给了他。"
      />
    )
  }

  const section = (snapshot.sections ?? []).find((s) => s.sort_order === row.section_ord)
  if (!section) {
    return (
      <AccessDenied
        title="大题已经不在了"
        description="创始人改过卷面结构（删了这个大题），请联系他确认。"
      />
    )
  }

  const { slots } = buildSegmentView(section, ownershipRes.ownership, meta)
  const existingIds = new Set((snapshot.items ?? []).map((i) => i.question_id))

  return (
    <div className="space-y-4">
      <PageHeader
        title="子卷任务"
        description={`你负责「${section.title || `第 ${row.section_ord} 大题`}」第 ${row.from_qno}~${row.to_qno} 题。挑满后点「提交这段」就锁上了。`}
      />
      <p className="text-sm text-muted-foreground">
        {snapshot.title} · 第 {snapshot.version_no} 版 ·{" "}
        <Link href={`/papers/${snapshot.paper_id}`} className="underline underline-offset-2 hover:text-foreground">
          看整卷
        </Link>
      </p>
      <SegmentEditor
        assignment={meta}
        section={section}
        slots={slots}
        existingIds={existingIds}
        nodes={nodes}
        paperTitle={snapshot.title}
      />
    </div>
  )
}
