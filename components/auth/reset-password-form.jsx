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

/**
 * 忘记密码（未登录自助重置）。
 *
 * 验证口径：**手机号或邮箱 + 注册时填写的姓名**，对上即可自己设新密码。
 * 判定全在服务端（RPC self_reset_password，见 supabase/migrations/0072/0073），
 * 这里只做格式校验与文案展示 —— 前端能绕，服务端才是边界。
 *
 * 两个别改的地方：
 *   · 标识符**原样**传给服务端，不在这里换算成合成邮箱：归一化由 SQL 侧统一做，
 *     网页端/Flutter/SQL 三处口径必须一致（lib/phone.js 顶部有说明）。
 *     这里调 toAuthIdentifier 只是为了在格式不对时给出更好的提示。
 *   · RPC 返回的是 `{ok, error}` 而**不是**抛错（0073：raise 会回滚失败计数，
 *     限流会被绕过），所以必须判 data.ok，别只看 error。
 */
export function ResetPasswordForm() {
  const router = useRouter()
  const [identifier, setIdentifier] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    const { email } = toAuthIdentifier(identifier)
    if (!email) {
      setError("请输入正确的手机号或邮箱")
      return
    }
    if (!name.trim()) {
      setError("请填写注册时使用的姓名")
      return
    }
    if (password.length < 6) {
      setError("新密码长度至少 6 位")
      return
    }
    // 上界按**字节**算：bcrypt 的 72 字节截断，服务端也是这么判的（见 0074）。
    // 用字符数会让 25 个汉字（75 字节）在端上被放行、到服务端才被拒。
    if (new TextEncoder().encode(password).length > 72) {
      setError("新密码过长：最多 72 字节（约 24 个汉字或 72 个字母）")
      return
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致")
      return
    }

    startTransition(async () => {
      const supabase = createClient()
      const { data, error: rpcError } = await supabase.rpc("self_reset_password", {
        p_identifier: identifier,
        p_name: name,
        p_new_password: password,
      })
      if (rpcError) {
        setError(translateAuthError(rpcError.message))
        return
      }
      if (!data?.ok) {
        setError(data?.error ?? "重置失败，请稍后再试")
        return
      }

      // 服务端已把该账号的会话与刷新令牌清掉（已签发的 access token 到期前仍有效，
      // 默认 1 小时——别对用户承诺"立刻下线"）；这里用新密码建一条自己的会话，
      // 省得学生再输一遍。建不起来（网络抖动等）也不阻断：密码已经改好了，退回登录页即可。
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) {
        setDone(true)
        return
      }
      router.replace("/dashboard")
      router.refresh()
    })
  }

  if (done) {
    return (
      <div className="grid gap-4">
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
          密码已重置成功，请用新密码登录。
        </p>
        {/* 本仓的 shadcn 基于 Base UI：组合用 render，不支持 asChild（见 components/app-sidebar.jsx:60） */}
        <Button className="w-full" nativeButton={false} render={<Link href="/login" />}>
          去登录
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="reset-identifier">手机号 / 邮箱</Label>
        <Input
          id="reset-identifier"
          // 同登录页：用 text 而非 email，否则移动端会弹带 @ 的键盘，而学生要输的是纯数字
          type="text"
          required
          autoComplete="username"
          placeholder="注册时用的手机号或邮箱"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reset-name">姓名</Label>
        <Input
          id="reset-name"
          type="text"
          required
          autoComplete="name"
          placeholder="注册时填写的姓名"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          要和注册时填的一致，用于确认是你本人。
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reset-password">新密码</Label>
        <Input
          id="reset-password"
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">至少 6 位</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reset-confirm">确认新密码</Label>
        <Input
          id="reset-confirm"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
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
        重置密码
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        想起来了？{" "}
        <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          返回登录
        </Link>
      </p>
    </form>
  )
}
