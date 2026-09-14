// 登录页壳：读取 next 回跳参数（校验防开放重定向后交给客户端表单）
import { LoginForm } from "@/components/auth/login-form"
import { PageHeader } from "@/components/page-header"

export const metadata = { title: "登录" }

// next 只允许站内路径：以 / 开头、非 // 开头、不含空白与反斜杠
function safeNext(raw) {
  if (typeof raw !== "string" || !raw) return "/dashboard"
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard"
  if (/[\s\\]/.test(raw)) return "/dashboard"
  return raw
}

export default async function LoginPage({ searchParams }) {
  const params = await searchParams
  const next = safeNext(params.next)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader centered title="欢迎回来" description="登录绵阳市中职共建题库，开始出题与审核" />
      <LoginForm next={next} />
    </div>
  )
}
