// 忘记密码页壳（公开页：(auth) 路由组 + proxy.js 的 AUTH_PAGES 双处登记，缺一处就会被挡回登录页）
import { ResetPasswordForm } from "@/components/auth/reset-password-form"
import { PageHeader } from "@/components/page-header"

export const metadata = { title: "找回密码" }

export default function ResetPasswordPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        centered
        title="找回密码"
        description="用注册时的手机号或邮箱，加上当时填写的姓名，验证通过后自己设置新密码"
      />
      <ResetPasswordForm />
    </div>
  )
}
