"use client"

import { useState, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import { translateAuthError } from "@/lib/auth-errors"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2Icon } from "lucide-react"

/**
 * 已登录时修改密码（记得住旧密码的同学走这条，比"忘记密码"少一步）。
 *
 * 走 Supabase 原生 updateUser，不碰 auth.users 哈希（那是 0072 给未登录自助重置留的路）。
 * 两个刻意的取舍：
 *   · **先验旧密码**：updateUser 本身不要求旧密码，不验的话，拿到一台已解锁设备的
 *     人可以直接改密把号主锁在门外。这里用 signInWithPassword 验一次 —— 顺带也确认了
 *     账号没被停用。失败按"当前密码不正确"提示，不细说原因。
 *   · **不动其他设备的会话**（与忘记密码不同，那条路会踢）：主动改密的人本来就掌握
 *     当前密码，多数 App 也是这个行为 —— 在电脑上改密码不该把手机踢下线。
 */
export function PasswordCard({ email }) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSaved(false)

    if (!current) {
      setError("请输入当前密码")
      return
    }
    if (next.length < 6) {
      setError("新密码长度至少 6 位")
      return
    }
    // 上界按字节：bcrypt 在 72 字节处截断，GoTrue 对超长密码直接报错
    if (new TextEncoder().encode(next).length > 72) {
      setError("新密码过长：最多 72 字节（约 24 个汉字或 72 个字母）")
      return
    }
    if (next !== confirm) {
      setError("两次输入的新密码不一致")
      return
    }
    if (next === current) {
      setError("新密码不能与当前密码相同")
      return
    }

    startTransition(async () => {
      const supabase = createClient()
      const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: current })
      if (verifyError) {
        setError("当前密码不正确")
        return
      }
      const { error: updateError } = await supabase.auth.updateUser({ password: next })
      if (updateError) {
        setError(translateAuthError(updateError.message))
        return
      }
      setCurrent("")
      setNext("")
      setConfirm("")
      setSaved(true)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">登录密码</CardTitle>
        <CardDescription>
          修改后当前设备保持登录；忘记密码可在登录页用「手机号/邮箱 + 姓名」自助重置。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="pw-current">当前密码</Label>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pw-new">新密码</Label>
              <Input
                id="pw-new"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pw-confirm">确认新密码</Label>
              <Input
                id="pw-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          {saved && (
            <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
              密码已修改，下次登录请用新密码。
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">至少 6 位</p>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="size-4 animate-spin" />}
              修改密码
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
