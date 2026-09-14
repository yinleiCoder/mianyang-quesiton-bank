// 注册页：服务端拉取启用中的学校列表（schools 对 anon 开放只读，0007 迁移），
// 学校在注册时绑定，身份任命由管理员事后进行。
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { RegisterForm } from "@/components/auth/register-form"
import { PageHeader } from "@/components/page-header"
import { createClient } from "@/lib/supabase/server"
import { ShieldCheckIcon } from "lucide-react"

export const metadata = { title: "注册" }

export default async function RegisterPage() {
  const supabase = await createClient()
  const { data: schools } = await supabase
    .from("schools")
    .select("id, name")
    .eq("is_active", true)
    .order("name")

  return (
    <div className="flex flex-col gap-6">
      <PageHeader centered title="创建账号" description="教师自助注册，绑定所属学校后等待学校管理员任命" />
      <Alert variant="default" className="border-primary/30 bg-primary/5">
        <ShieldCheckIcon className="size-4 text-primary" />
        <AlertTitle className="text-sm font-medium">系统管理员引导</AlertTitle>
        <AlertDescription className="text-xs">
          系统管理员角色固定一人。请让管理员<b>先注册</b>——首个注册账号将自动成为系统管理员，
          用于创建学校、任命学校管理员与市级专家。
        </AlertDescription>
      </Alert>
      <RegisterForm schools={schools ?? []} />
    </div>
  )
}
