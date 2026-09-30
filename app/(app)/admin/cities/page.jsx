// 市管理（仅系统管理员）：创建、启用/停用
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { CitiesManager } from "@/components/admin/cities-manager"
import { CITY_COLUMNS } from "@/lib/admin-tables"

export const metadata = { title: "市管理" }

export default async function AdminCitiesPage() {
  const ctx = await requireUser()
  if (!ctx.isAdmin) {
    return <AccessDenied title="仅系统管理员可访问" description="市名单由系统管理员维护；学校必须挂在市下面。" />
  }

  const supabase = await createClient()
  const { data: cities, error } = await supabase.from("cities").select(CITY_COLUMNS).order("name")
  if (error) throw error

  return (
    <div className="space-y-4">
      <PageHeader
        title="市管理"
        description="省下的市。学校挂在市上，教师/题目/试卷的市由学校推导（不单独记录）；题库本身全省共享，市决定的是审批与管理的归属。"
      />
      <CitiesManager cities={cities ?? []} />
    </div>
  )
}
