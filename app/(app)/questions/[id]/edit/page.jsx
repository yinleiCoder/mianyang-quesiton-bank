// 修改草稿 / 按退回意见修改（同一版本行原地编辑后重提 → 全链重审）
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { AccessDenied } from "@/components/access-denied"
import { QuestionEditor } from "@/components/questions/question-editor"
import { PageHeader } from "@/components/page-header"
import { fromContent } from "@/lib/question-model"
import { loadSubjectNodes } from "@/lib/reference-data"
import { fmtDateTime24 } from "@/lib/format"

export const metadata = { title: "修改题目" }

export default async function EditQuestionPage({ params }) {
  const { id } = await params
  const ctx = await requireUser()
  const supabase = await createClient()

  const { data: question, error: qError } = await supabase
    .from("questions")
    .select("id, creator_id, course_node_id")
    .eq("id", id)
    .maybeSingle()
  if (qError) throw qError
  if (!question) return <AccessDenied title="题目不存在" />
  if (question.creator_id !== ctx.user.id) {
    return <AccessDenied title="仅作者可修改" description="该题不是你的题目；如需协助请联系学校管理员。" />
  }

  // 当前在流版本（草稿/被退回）才可编辑；审核中需先撤回
  const { data: versions } = await supabase
    .from("question_versions")
    .select("id, status, qtype, difficulty, content, created_at, submitted_at")
    .eq("question_id", id)
    .in("status", ["draft", "returned"])
    .order("version_no", { ascending: false })
    .limit(1)
  const working = versions?.[0]
  if (!working) {
    return (
      <AccessDenied
        title="该题当前不可编辑"
        description="审核中或已入库的题目不能直接修改：审核中请先在我的题目里撤回；已入库题目的修改将以新版本走审批（后续版本提供）。"
      />
    )
  }

  const [nodes, tagsRes, notesRes] = await Promise.all([
    loadSubjectNodes(),
    supabase.from("version_tags").select("tag_id, tag_name").eq("version_id", working.id),
    supabase
      .from("approvals")
      .select("state, stage, comment, decided_by, decided_at")
      .eq("version_id", working.id)
      .eq("state", "returned")
      .order("decided_at", { ascending: false })
      .limit(1),
  ])
  const note = notesRes.data?.[0] ?? null
  let decidedByName = null
  if (note?.decided_by && note.decided_by !== ctx.user.id) {
    const { data: who } = await supabase
      .from("profiles")
      .select("name")
      .eq("user_id", note.decided_by)
      .single()
    decidedByName = who?.name ?? null
  }

  const initial = fromContent(
    working.qtype,
    working.difficulty,
    working.content,
    (tagsRes.data ?? []).map((t) => ({ id: t.tag_id, name: String(t.tag_name) }))
  )
  // fromContent 不含节点（内容契约里没有它）；缺了这行「保存/提交」会因 !d.nodeId 恒为禁用
  initial.nodeId = question.course_node_id

  return (
    <div className="space-y-4">
      <PageHeader
        title={working.status === "returned" ? "按退回意见修改" : "编辑草稿"}
        description="保存后修改立即生效于该版本；再次提交将从教研组长环节重新审核（全链重审）。"
      />
      <QuestionEditor
        nodes={nodes}
        initial={initial}
        versionId={working.id}
        returnedNote={
          note
            ? {
                comment: note.comment,
                decidedByName,
                decidedAt: fmtDateTime24(note.decided_at),
              }
            : null
        }
        mode="edit"
      />
    </div>
  )
}
