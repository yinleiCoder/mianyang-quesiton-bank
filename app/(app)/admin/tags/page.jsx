// 标签管理（仅系统管理员）：重命名 / 合并规范。
// 版本内已落 tag_name 快照，改名与合并不影响历史版本的展示名。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { TagsManager } from "@/components/admin/tags-manager"
import { TAG_COLUMNS } from "@/lib/admin-tables"

export const metadata = { title: "标签管理" }

export default async function AdminTagsPage() {
  const ctx = await requireUser()
  if (!ctx.isAdmin) {
    return <AccessDenied title="仅系统管理员可访问" description="标签由教师自由创建；管理员负责合并重复、规范名称。" />
  }

  const supabase = await createClient()
  const { data: tags, error } = await supabase.from("tags").select(TAG_COLUMNS).order("name")
  if (error) throw error

  return (
    <div className="space-y-4">
      <PageHeader
        title="标签管理"
        description="知识点标签由教师自由创建（忽略大小写去重）。合并后：在途版本跟随新名，已入库的历史版本保留打标签时的名称快照。"
      />
      <TagsManager tags={tags ?? []} />
    </div>
  )
}
