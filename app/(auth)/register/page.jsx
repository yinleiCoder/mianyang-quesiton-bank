// 注册页：服务端拉取启用中的学校列表（schools 对 anon 开放只读，0007 迁移）与班级名单
//（classes 对 anon 开放只读，0063 迁移 —— 学生要在登录前选班级）。学校在注册时绑定，
// 身份任命由管理员事后进行。
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { RegisterForm } from "@/components/auth/register-form"
import { PageHeader } from "@/components/page-header"
import { loadClasses, loadSchools } from "@/lib/reference-data"
import { ShieldCheckIcon } from "lucide-react"

export const metadata = { title: "注册" }

// 注册页在运行时本来就是动态渲染（响应头是 no-store：它按请求读学校/班级名单，
// 管理员新建学校或班级后应当立刻可选）。显式声明成 dynamic 只是把这个事实告诉构建器 ——
// 否则 next build 会先试着预渲染一次，在拿到 cookies() 之前就把名单查完，
// 于是**每次构建都绑死一次线上 Supabase**：网络一抖，构建就挂在 60 秒超时上（实测 PGRST003）。
// 数据本身仍走 unstable_cache，所以运行时不会因此多打请求。
export const dynamic = "force-dynamic"

export default async function RegisterPage() {
  // 走参考数据缓存（与注册页原本每次直查相比省一次往返）；班级全量取回后由表单按所选学校筛
  const [schools, allClasses] = await Promise.all([loadSchools(), loadClasses()])
  const classes = allClasses
    .filter((c) => c.is_active)
    .map((c) => ({ id: c.id, school_id: c.school_id, name: c.name }))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader centered title="创建账号" description="教师与学生自助注册，绑定所属学校后等待学校管理员任命" />
      <Alert variant="default" className="border-primary/30 bg-primary/5">
        <ShieldCheckIcon className="size-4 text-primary" />
        <AlertTitle className="text-sm font-medium">系统管理员引导</AlertTitle>
        <AlertDescription className="text-xs">
          系统管理员角色固定一人。请让管理员<b>先注册</b>——首个注册账号将自动成为系统管理员，
          用于创建学校、任命学校管理员与市级专家。
        </AlertDescription>
      </Alert>
      <RegisterForm
        schools={(schools ?? []).filter((s) => s.is_active).map((s) => ({ id: s.id, name: s.name }))}
        classes={classes}
      />
    </div>
  )
}
