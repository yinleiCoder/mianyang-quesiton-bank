// 组卷编辑器宿主（服务端壳）。
// 路由键用 versionId 而不是 paperId：新建试卷时 RPC 直接返回 version_id，
// 不必再打一次往返去换 paper_id；改版也是"拿到新 version_id 就进来"。
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperVersion } from "@/lib/paper-workbench"
import { loadSubjectNodes } from "@/lib/reference-data"
import { AccessDenied } from "@/components/access-denied"
import { PaperEditor } from "@/components/papers/paper-editor"

export const metadata = { title: "组卷" }

export default async function PaperEditPage({ params }) {
  const { versionId } = await params
  await requireUser()
  const ctx = await getAuthContext()
  const supabase = await createClient()

  if (!ctx.isTeacher) {
    return (
      <AccessDenied title="只有教师可以组卷" description="教师身份审核通过后才能编辑试卷。" />
    )
  }

  // 可见性由 get_paper_version 断言（作者/管理员/本校管理员/审批参与人）
  let snapshot = null
  try {
    snapshot = await loadPaperVersion(supabase, versionId)
  } catch {
    snapshot = null
  }
  if (!snapshot) {
    return (
      <AccessDenied title="试卷不可见" description="这份试卷不存在，或不属于你。" />
    )
  }

  const editable = snapshot.status === "draft" || snapshot.status === "returned"
  const isOwner = snapshot.created_by === ctx.user?.id
  if (!editable || !isOwner) {
    return (
      <AccessDenied
        title="这份试卷现在不能编辑"
        description={
          editable
            ? "只有作者本人可以编辑自己的试卷。"
            : "试卷已提交审核或已入库。审核期间如需修改请先撤回；已入库的试卷请从详情页发起改版。"
        }
      />
    )
  }

  const nodes = await loadSubjectNodes()

  return <PaperEditor initialSnapshot={snapshot} nodes={nodes} />
}
