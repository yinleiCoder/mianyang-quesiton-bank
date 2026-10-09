// 标签管理（仅系统管理员）：重命名 / 合并规范。
// 版本内已落 tag_name 快照，改名与合并不影响历史版本的展示名。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { TagsManager } from "@/components/admin/tags-manager"
import { TAG_COLUMNS } from "@/lib/admin-tables"
import { SUBJECT_NODE_COLUMNS } from "@/lib/subject-nodes"

export const metadata = { title: "知识点管理" }

export default async function AdminTagsPage() {
  const ctx = await requireUser()
  if (!ctx.isAdmin) {
    return <AccessDenied title="仅系统管理员可访问" description="知识点由教师自由创建；管理员负责指派学科、合并重复、规范名称。" />
  }

  const supabase = await createClient()
  // 科目树随页面一起取：指派弹层要选节点，且列表里要把"挂在哪个学科"显示成人看得懂的名字。
  const [tagsRes, nodesRes] = await Promise.all([
    supabase.from("tags").select(TAG_COLUMNS).order("name"),
    supabase
      .from("subject_nodes")
      .select(SUBJECT_NODE_COLUMNS)
      .order("sort_order")
      .order("name"),
  ])
  if (tagsRes.error) throw tagsRes.error
  if (nodesRes.error) throw nodesRes.error

  return (
    <div className="space-y-4">
      <PageHeader
        title="知识点管理"
        description="知识点由教师自由创建（同一学科、同一父级下不重名）。这里负责把它们指到所属学科、合并重复、规范名称——没指派学科的知识点不会出现在教师的候选里。合并后：在途版本跟随新名，已入库的历史版本保留打标签时的名称快照。"
      />
      <TagsManager tags={tagsRes.data ?? []} nodes={nodesRes.data ?? []} />
    </div>
  )
}
