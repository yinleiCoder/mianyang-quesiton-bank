"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { translateAuthError } from "@/lib/auth-errors"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2Icon, MailCheckIcon } from "lucide-react"

export function RegisterForm({ schools, classes = [] }) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [schoolId, setSchoolId] = useState("")
  const [identity, setIdentity] = useState("student")
  const [classId, setClassId] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState(null)
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState(false) // 已提交（等待邮箱验证）

  // 班级按所选学校筛。学生端**只选班级**：专业大类与专业由班级带出（服务端 handle_new_user），
  // 不再让学生手输 —— 线上曾经出现过同一个班被写成八种名字的情况，就是这么来的。
  const schoolClasses = classes.filter((c) => c.school_id === schoolId)

  function pickSchool(id) {
    setSchoolId(id)
    // 换学校必须清掉已选班级：旧班级可能不属于新学校，留着会被服务端静默丢弃，
    // 但界面上会显示成一个"选中了却无效"的值
    setClassId("")
  }

  function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError("两次输入的密码不一致")
      return
    }
    startTransition(async () => {
      const supabase = createClient()
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          // identity=teacher → 服务端置「教师待审核」，经学校管理员审核后获得出题等教师权限（0025）。
          // class_id 是 0063 加的新键：命中时服务端由班级派生专业与班级名，并**忽略**旧的
          // major_category / major / class_name 文本键。旧键名一个都没改，所以服务端仍兼容旧客户端。
          // 班级可选：学校还没建班时不阻断注册，学生先落「未分班」，由学校管理员事后归班。
          data: {
            name: name.trim(),
            school_id: schoolId || null,
            identity,
            class_id: identity === "student" ? classId || null : null,
          },
          // 验证邮件里的链接默认回登录页
          emailRedirectTo: `${window.location.origin}/login`,
        },
      })
      if (error) {
        setError(translateAuthError(error.message))
        return
      }
      // 已关闭邮箱验证时直接带会话返回；否则提示查收邮件
      if (data.session) {
        router.push("/dashboard")
        router.refresh()
      } else {
        setDone(true)
      }
    })
  }

  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
          <MailCheckIcon className="size-6" />
        </div>
        <div className="space-y-1">
          <p className="font-medium">注册申请已提交</p>
          <p className="text-sm text-muted-foreground">
            验证链接已发送至 <span className="font-medium">{email}</span>，
            请到邮箱点击验证后即可登录。
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/login" />}>
          返回登录
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="reg-name">真实姓名</Label>
        <Input
          id="reg-name"
          required
          maxLength={50}
          placeholder="用于题目署名与审批展示"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reg-identity">身份</Label>
        <Select value={identity} onValueChange={setIdentity}>
          <SelectTrigger id="reg-identity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="student">学生</SelectItem>
            <SelectItem value="teacher">教师</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {identity === "teacher"
            ? "教师身份需学校管理员审核，审核期间可正常刷题；审核通过后可出题、参与审批。"
            : "学生身份仅可刷题练习（网页端可浏览题库，移动端刷题）。"}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reg-school">所属学校</Label>
        {/* 空值必须是 null 不能是 undefined：undefined 会被当成「非受控」，选完学校
            切成受控时 React 会报警告（Base UI 的 placeholder 判定也认 null） */}
        <Select value={schoolId || null} onValueChange={pickSchool}>
          <SelectTrigger id="reg-school" className="text-muted-foreground">
            <SelectValue placeholder="选择你所在的学校（可暂不选择）" />
          </SelectTrigger>
          <SelectContent>
            {schools.length === 0 && (
              <div className="px-2 py-3 text-center text-sm text-muted-foreground">
                暂无学校名单，请先联系系统管理员
              </div>
            )}
            {schools.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          所属学校。若学校尚未上线，可先不选择，随后由管理员在用户管理中绑定。
        </p>
      </div>
      {/* 班级只对学生出现：教师的「任教专业」由学校管理员在用户与任命里设置 */}
      {identity === "student" && (
        <div className="grid gap-2">
          <Label htmlFor="reg-class">班级</Label>
          <Select
            value={classId || null}
            onValueChange={setClassId}
            disabled={!schoolId || schoolClasses.length === 0}
          >
            <SelectTrigger id="reg-class" className="text-muted-foreground">
              <SelectValue
                placeholder={
                  !schoolId
                    ? "请先选择学校"
                    : schoolClasses.length === 0
                      ? "该校暂无可选班级"
                      : "选择你的班级（可暂不选择）"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {schoolClasses.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {!schoolId
              ? "先选择学校后即可选择班级。"
              : schoolClasses.length === 0
                ? "该校还没有建立班级，可先跳过，注册后由学校管理员分配。"
                : "选择班级后，你的专业大类与专业会由班级自动带出，无需手填。"}
          </p>
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="reg-email">邮箱（登录账号）</Label>
        <Input
          id="reg-email"
          type="email"
          required
          autoComplete="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reg-password">密码</Label>
        <Input
          id="reg-password"
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
        <Label htmlFor="reg-confirm">确认密码</Label>
        <Input
          id="reg-confirm"
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
        {pending && <Loader2Icon className="size-4 animate-spin" />}
        注册
      </Button>
      <div className="text-center text-sm text-muted-foreground">
        已有账号？{" "}
        <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          直接登录
        </Link>
      </div>
    </form>
  )
}
