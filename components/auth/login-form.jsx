"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { translateAuthError } from "@/lib/auth-errors"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2Icon } from "lucide-react"

export function LoginForm({ next }) {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const supabase = createClient()
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
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
        <Label htmlFor="login-email">邮箱</Label>
        <Input
          id="login-email"
          type="email"
          required
          autoComplete="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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
      {/* 站内反馈入口在登录后才有，而登不上的人恰恰最需要联系管理员——这里留一句人工通道 */}
      <p className="text-center text-xs text-muted-foreground">
        登录不上或账号有问题？请联系你所在学校的管理员或任课教师。
      </p>
    </form>
  )
}
