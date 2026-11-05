// AI 配置：全站 AI 功能共用的密钥/模型入口（教师/管理员）。
//
// 密钥仍然只存在使用者自己的浏览器 localStorage 里：本页不写数据库、不经过服务器。
import { requireUser, getAuthContext } from "@/lib/auth"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { AiSettingsPage } from "@/components/settings/ai-settings-page"

export const metadata = { title: "AI 配置" }

export default async function AiSettingsRoute() {
  await requireUser()
  const ctx = await getAuthContext()
  if (!(ctx.isTeacher || ctx.isSchoolAdmin || ctx.isAdmin)) {
    return (
      <AccessDenied
        title="仅教师及以上可配置 AI"
        description="学生端不需要密钥；AI 导入、分析、审题、教案与评分都是教师功能。"
      />
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="AI 配置"
        description="全站 AI 功能共用这一个密钥与模型；密钥只保存在本机浏览器，不上传、不跨设备。"
      />
      <AiSettingsPage />
    </div>
  )
}
