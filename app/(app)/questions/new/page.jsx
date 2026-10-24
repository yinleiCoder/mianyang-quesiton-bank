// 出题（新题目）：需已绑定学校（RPC 兜底），且科目树有可挂题节点
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { isAttachable } from "@/lib/subject-nodes"
import { loadSubjectNodes } from "@/lib/reference-data"
import { QuestionEditor } from "@/components/questions/question-editor"
import { AccessDenied } from "@/components/access-denied"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { FolderTreeIcon, SchoolIcon } from "lucide-react"

export const metadata = { title: "出题" }

export default async function NewQuestionPage() {
  const ctx = await requireUser()
  // 出题是教师专属，服务端 create/save 的 RPC 也会拒；这里先给一句人话并挡住页面。
  // 学生与教师待审核账号都可以浏览题库，但不能进入出题编辑器。
  if (!ctx.isTeacher) {
    return (
      <AccessDenied
        title="仅教师可出题"
        description={
          ctx.isPendingTeacher
            ? "教师身份审核通过后才能出题；现在可以先浏览题库。"
            : "学生账号可以浏览题库、参加考试；出题需要审核通过的教师身份。"
        }
      />
    )
  }
  if (!ctx.profile?.school_id) {
    return (
      <EmptyState
        icon={SchoolIcon}
        title="你的账号尚未绑定学校"
        description="出题需要以学校名义共建。请联系系统管理员在「用户与任命」中为你绑定学校。"
      />
    )
  }
  // 查询失败要抛出：否则会误报成「科目树还没有可挂题的节点」
  const nodes = await loadSubjectNodes()

  const attachable = (nodes ?? []).filter(
    (n) => isAttachable(n.kind) && !n.is_frozen
  )
  if (attachable.length === 0) {
    return (
      <EmptyState
        icon={FolderTreeIcon}
        title="科目树还没有可挂题的节点"
        description="请联系系统管理员到「科目树维护」创建公共学科（语文/数学/英语…）或专业目录（专业大类 → 专业 → 课程）节点后即可出题。"
        action={
          ctx.isAdmin ? (
            <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/admin/tree" />}>
              去维护科目树
            </Button>
          ) : null
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="出题"
        description="六种题型任选；综合题可添加最多 20 道子题（不能嵌套综合题）。草稿与提交都先做内容结构校验，校验规则与入库口径一致。"
      />
      <QuestionEditor nodes={nodes ?? []} mode="new" />
    </div>
  )
}
