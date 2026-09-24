// 科目树维护（仅系统管理员）：公共科目（discipline 单层或下挂 course）与
// 专业目录（category → major → course）两棵树，支持增/改名/冻结/删除。
// 任意层级的节点都能挂题（2026-09-24 起，见 lib/subject-nodes.js）。
import { requireUser } from "@/lib/auth"
import { loadSubjectNodes } from "@/lib/reference-data"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { TreeManager } from "@/components/admin/tree-manager"

export const metadata = { title: "科目树维护" }

export default async function AdminTreePage() {
  const ctx = await requireUser()
  if (!ctx.isAdmin) {
    return <AccessDenied title="仅系统管理员可访问" description="科目树是公共元数据，由系统管理员统一维护。" />
  }

  // 查询失败要抛出（由 (app)/error.jsx 兜底重试），否则空列表会被误认为「树是空的」
  const nodes = await loadSubjectNodes()

  return (
    <div className="space-y-4">
      <PageHeader
        title="科目树维护"
        description={
          <>
            公共科目树（语文、数学…）与专业科目树（专业大类 → 专业 → 课程）。
            教师可以挂在 <b>任意层级</b> 的节点上（专业大类、专业、课程、公共学科都行）；
            组长与专家按节点任命，覆盖后代科目。
          </>
        }
      />
      <TreeManager nodes={nodes ?? []} />
    </div>
  )
}
