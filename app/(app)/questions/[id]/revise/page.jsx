// 发起改版：作者本人对"已入库题"以当前内容为底稿创建新版本草稿（走两级重审）。
// 页面守卫与 create_edit_draft 收口一致；节点由原题锁定，编辑器只读展示科目路径。
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { AccessDenied } from "@/components/access-denied"
import { QuestionEditor } from "@/components/questions/question-editor"
import { PageHeader } from "@/components/page-header"
import { fromContent } from "@/lib/question-model"
import { INFLIGHT } from "@/lib/question-workbench"
import { indexNodes, subjectNodesQuery } from "@/lib/subject-nodes"
import { fmtDateTime24 } from "@/lib/format"

export const metadata = { title: "发起改版" }

export default async function ReviseQuestionPage({ params }) {
  const { id } = await params
  const ctx = await requireUser()
  const supabase = await createClient()

  const { data: question } = await supabase
    .from("questions")
    .select("id, creator_id, state, course_node_id, current_published_version_id")
    .eq("id", id)
    .maybeSingle()
  if (!question) return <AccessDenied title="题目不存在" />
  if (question.creator_id !== ctx.user.id) {
    return <AccessDenied title="仅作者可发起改版" description="该题不是你的题目；如需协助请联系学校管理员。" />
  }

  // 有在审/未完成的版本时优先处理它（改版与修改草稿互斥：每问至多一个在流版本）
  const { data: inflight } = await supabase
    .from("question_versions")
    .select("id, status, version_no")
    .eq("question_id", id)
    .in("status", INFLIGHT)
    .limit(1)
  if ((inflight ?? []).length > 0) {
    return (
      <AccessDenied
        title="该题已有在审/未完成的修改版本"
        description={
          <>
            请先到{" "}
            <Link className="underline underline-offset-2" href="/questions?tab=mine">
              我的题目
            </Link>{" "}
            处理 v{inflight[0].version_no}（审核中可撤回；草稿/被退回可继续编辑提交）。同一题同一时间只允许一个在流版本。
          </>
        }
      />
    )
  }

  if (question.state === "offline") {
    return (
      <AccessDenied
        title="题目已下线，暂不能改版"
        description={
          <>
            下线期间题目不可用。如需更新内容，请先到{" "}
            <Link className="underline underline-offset-2" href="/questions?tab=mine">
              我的题目
            </Link>{" "}
            发起「恢复上线」，通过后可再来发起改版。
          </>
        }
      />
    )
  }

  const { data: cur } = await supabase
    .from("question_versions")
    .select("id, status, version_no, qtype, difficulty, content, published_at")
    .eq("id", question.current_published_version_id)
    .maybeSingle()
  if (!cur) {
    return <AccessDenied title="题目尚未入库" description="该题还没有入库版本，请直接编辑草稿提交。" />
  }

  const nodeRes = await subjectNodesQuery(supabase)
  const { byId: nodeMap, pathOf: nodePath } = indexNodes(nodeRes.data)
  const node = nodeMap.get(question.course_node_id)
  if (node?.is_frozen) {
    return <AccessDenied title="科目节点已冻结" description={`「${node.name}」节点已冻结，不能为该题发起新版本。`} />
  }

  const tagsRes = await supabase.from("version_tags").select("tag_id, tag_name").eq("version_id", cur.id)

  const initial = fromContent(
    cur.qtype,
    cur.difficulty,
    cur.content,
    (tagsRes.data ?? []).map((t) => ({ id: t.tag_id, name: String(t.tag_name) }))
  )
  initial.nodeId = question.course_node_id

  return (
    <div className="space-y-4">
      <PageHeader
        title="发起改版"
        description={`v${cur.version_no} 入库于 ${fmtDateTime24(cur.published_at)}。以当前入库内容为底稿创建新版本，重新走「教研组长 → 市级专家」两级审批；审批通过后自动替换上线，审批期间旧版本照常供全市使用。`}
      />
      <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        归属科目：{nodePath(question.course_node_id)} · 将创建为 v{cur.version_no + 1}
      </div>
      <QuestionEditor nodes={nodeRes.data ?? []} initial={initial} reviseQuestionId={question.id} mode="new" />
    </div>
  )
}
