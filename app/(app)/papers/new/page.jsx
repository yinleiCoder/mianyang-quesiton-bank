// 新建试卷。教师专属：非教师（学生/待审核教师）看得到入口也只能被 RPC 拦下，
// 这里直接给出明确说明，免得填完一屏才被拒。
import Link from "next/link"
import { requireUser, getAuthContext } from "@/lib/auth"
import { loadSubjectNodes } from "@/lib/reference-data"
import { indexNodes } from "@/lib/subject-nodes"
import { PageHeader } from "@/components/page-header"
import { AccessDenied } from "@/components/access-denied"
import { NewPaperForm } from "@/components/papers/new-paper-form"
import { Button } from "@/components/ui/button"

export const metadata = { title: "新建试卷" }

export default async function NewPaperPage() {
  await requireUser()
  const ctx = await getAuthContext()
  if (!ctx.isTeacher) {
    return (
      <AccessDenied
        title="只有教师可以组卷"
        description="教师身份审核通过后才能从题库挑题组成试卷。"
      />
    )
  }

  const nodes = await loadSubjectNodes()
  const { byId } = indexNodes(nodes)
  // 只有能挂题的节点可选：与 check_can_author 的口径一致（否则选完才被服务端拒绝）
  const attachable = nodes
    .filter((n) => n.kind === "discipline" || n.kind === "course")
    .map((n) => ({ id: n.id, name: n.name, path: byId.get(n.id)?.path ?? n.name }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="新建试卷"
        description="先填卷头信息，创建后进入组卷编辑器挑选题目、设定分值。"
      />
      {attachable.length === 0 ? (
        <AccessDenied
          title="暂无可用的科目节点"
          description="科目树里还没有可挂题的节点，请联系系统管理员维护科目树后再来组卷。"
        />
      ) : (
        <NewPaperForm nodes={attachable} />
      )}
      <Button variant="ghost" nativeButton={false} render={<Link href="/papers" />}>
        返回组卷库
      </Button>
    </div>
  )
}
