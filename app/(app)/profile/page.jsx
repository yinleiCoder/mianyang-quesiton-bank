// 个人资料：头像（OSS avatars/…）、姓名、邮箱（经 Supabase Auth 更换）、绑定学校。
// 写路径全部收口：update_own_profile RPC（姓名/学校/头像）与 auth.updateUser（邮箱）；
// 邮箱变更由 0019 触发器镜像到 profiles.email。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { ProfileEditor } from "@/components/profile/profile-editor"
import { PageHeader } from "@/components/page-header"

export const metadata = { title: "个人资料" }

export default async function ProfilePage() {
  const ctx = await requireUser()
  const profile = ctx.profile
  const supabase = await createClient()

  const { data: schools, error } = await supabase
    .from("schools")
    .select("id, name")
    .eq("is_active", true)
    .order("name")
  if (error) throw error

  return (
    <div className="space-y-4">
      <PageHeader
        title="个人资料"
        description="维护你的姓名、头像与学校归属；这些信息将展示给同系统审核人与管理员。"
      />
      <ProfileEditor
        userId={ctx.user.id}
        email={ctx.user.email}
        initial={{
          name: profile?.name ?? "",
          schoolId: profile?.school_id ?? null,
          avatarKey: profile?.avatar_url ?? null,
        }}
        schools={schools ?? []}
      />
    </div>
  )
}
