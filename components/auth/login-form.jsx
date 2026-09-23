"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { translateAuthError } from "@/lib/auth-errors"
import { toAuthIdentifier } from "@/lib/phone"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2Icon } from "lucide-react"

export function LoginForm({ next }) {
  const router = useRouter()
  // 一个输入框收两种标识：学生用手机号，教师/管理员用邮箱。
  // 分流规则在 lib/phone.js 的 toAuthIdentifier —— 含 @ 走邮箱，否则走手机号。
  const [identifier, setIdentifier] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    const { email } = toAuthIdentifier(identifier)
    // 走到这里说明既不像邮箱、也不是合法手机号。**不能**把它原样丢给
    // signInWithPassword —— Supabase 会把 "1380013" 当成邮箱去查，报回
    // "Invalid login credentials"，用户看到「密码不对」却根本没意识到是号码打错了。
    if (!email) {
      setError("请输入正确的手机号或邮箱")
      return
    }

    startTransition(async () => {
      const supabase = createClient()
      // 手机号账号在 auth.users 里存的是合成邮箱（见 lib/phone.js 顶部说明），
      // 所以两条路最终都走 email 参数。
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError(translateAuthError(error.message))
        return
      }
      router.push(next)
      router.refresh()
    })
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="login-identifier">手机号 / 邮箱</Label>
        <Input
          id="login-identifier"
          // 用 text 而不是 email：email 类型会让移动端弹带 @ 的键盘，
          // 而学生大多数时候要输的是纯数字
          type="text"
          required
          autoComplete="username"
          placeholder="学生填手机号，教师填邮箱"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="login-password">密码</Label>
        </div>
        <Input
          id="login-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending && <Loader2Icon className="animate-spin" />}
        登录
      </Button>
      <div className="text-center text-sm text-muted-foreground">
        还没有账号？{" "}
        <Link href="/register" className="font-medium text-primary underline-offset-4 hover:underline">
          注册账号
        </Link>
      </div>
      {/* 人工通道仍然留着（姓名记错、手机号换了的同学只能走这条），
          但绝大多数情况可以自助：凭手机号/邮箱 + 注册姓名自己设新密码。 */}
      <p className="text-center text-xs text-muted-foreground">
        忘记密码？{" "}
        <Link href="/reset-password" className="font-medium text-primary underline-offset-4 hover:underline">
          用手机号/邮箱和姓名重置
        </Link>
        ；姓名也记不清或号码已换，联系你所在学校的管理员或任课教师。
      </p>
    </form>
  )
}
