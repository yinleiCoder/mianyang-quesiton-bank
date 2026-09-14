// 学校管理（仅系统管理员）：创建、启用/停用
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { SchoolsManager } from "@/components/admin/schools-manager"
import { SCHOOL_COLUMNS } from "@/lib/admin-tables"

export const metadata = { title: "学校管理" }

export default async function AdminSchoolsPage() {
  const ctx = await requireUser()
  if (!ctx.isAdmin) {
    return <AccessDenied title="仅系统管理员可访问" description="学校名单由系统管理员维护；教师注册时在此下拉选择学校。" />
  }

  const supabase = await createClient()
  const { data: schools, error } = await supabase.from("schools").select(SCHOOL_COLUMNS).order("name")
  if (error) throw error

  return (
    <div className="space-y-4">
      <PageHeader
        title="学校管理"
        description="参建学校名单：注册页下拉、组长任命的学校范围都以此为据。"
      />
      <SchoolsManager schools={schools ?? []} />
    </div>
  )
}
