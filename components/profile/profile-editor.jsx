"use client"

// 个人资料编辑器：姓名 / 绑定学校 / 邮箱（Supabase Auth 更换，含确认流程）/ 头像（OSS 直传预览）。
// 约束与提示：
//   · 姓名必填；学校仅可选启用中的学校；换校/解绑存在身份约束（组长任命、学校管理员），由 RPC 兜底报错；
//   · 头像 avatarKey 存相对 key（avatars/…），展示用 avatarUrl() 拼 CNAME 域名；≤5MB 的 png/jpg/webp。
//     更换/移除时旧对象由 /api/oss/delete 清理（先落库再删，失败只提示不回滚）。
import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { avatarUrl } from "@/lib/oss-url"
import { deleteOssObject } from "@/lib/upload"
import { TIERS, formatLimit } from "@/lib/media-spec"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { MediaUploaderDialog } from "@/components/media-uploader"
import { Loader2Icon, MailIcon, PencilIcon, Trash2Icon } from "lucide-react"

const NONE_SCHOOL = "__none__"

export function ProfileEditor({ userId, email, initial, schools }) {
  const router = useRouter()
  const supabaseRef = React.useRef(null)
  const getSb = () => (supabaseRef.current ??= createClient())

  const [name, setName] = React.useState(initial.name)
  const [school, setSchool] = React.useState(initial.schoolId ?? "")
  const [avatarKey, setAvatarKey] = React.useState(initial.avatarKey)
  const [saving, setSaving] = React.useState(false)
  const [avatarBusy, setAvatarBusy] = React.useState(false)
  const [avatarOpen, setAvatarOpen] = React.useState(false)
  const [removeAsk, setRemoveAsk] = React.useState(false)

  // 邮箱更换：输入框切换 + 提交（经 Auth API；确认流程下新邮箱待验证）
  const [emailDraft, setEmailDraft] = React.useState("")
  const [editingEmail, setEditingEmail] = React.useState(false)
  const [emailBusy, setEmailBusy] = React.useState(false)

  const nameDirty = name.trim() !== initial.name
  const schoolDirty = (school || null) !== initial.schoolId
  const canSave = (nameDirty || schoolDirty) && name.trim().length > 0

  // 换校/解绑需带当前头像 key 一并保存；约束冲突（组长任命等）由 RPC 明确报错
  async function saveProfile(patch = {}) {
    const prevKey = avatarKey // 保存前的旧头像 key，保存成功后用它清理 OSS 上的文件
    const nextKey = patch.avatarKey !== undefined ? patch.avatarKey : avatarKey
    setSaving(true)
    const supabase = getSb()
    const { error } = await supabase.rpc("update_own_profile", {
      p_name: patch.name !== undefined ? patch.name : name,
      p_school_id: patch.school !== undefined ? patch.school : school || null,
      p_avatar_url: nextKey,
    })
    setSaving(false)
    if (error) {
      toast.error(error.message)
      return false
    }
    if (patch.name !== undefined) setName(patch.name)
    if (patch.school !== undefined) setSchool(patch.school)
    if (patch.avatarKey !== undefined) setAvatarKey(patch.avatarKey)
    toast.success("已保存")
    router.refresh()
    // 先落库、再删对象，顺序不能反——服务端会校验「仍被引用则拒删」。
    // 只传相对 key：历史行里可能存的是完整 URL，那种形态没有对应的对象可删。
    // 不 await：删除是收尾动作，不该拖慢交互；失败也只提示，不影响已经成功的保存。
    if (
      patch.avatarKey !== undefined &&
      prevKey &&
      prevKey !== nextKey &&
      prevKey.startsWith("avatars/")
    ) {
      deleteOssObject(prevKey).then(({ ok, error: e }) => {
        if (!ok) toast.warning(`头像已更新，但旧文件未能删除：${e}`)
      })
    }
    return true
  }

  function doSaveBasic() {
    saveProfile({ name: name.trim(), school: school || null })
  }

  async function doChangeEmail() {
    const next = emailDraft.trim().toLowerCase()
    if (!next) return
    if (next === email.toLowerCase()) {
      setEditingEmail(false)
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      toast.error("邮箱格式不正确")
      return
    }
    setEmailBusy(true)
    const supabase = getSb()
    const { data, error } = await supabase.auth.updateUser({ email: next })
    setEmailBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    if (data.user?.email === next) {
      toast.success("邮箱已更换")
      router.refresh()
    } else {
      toast.success("已向新邮箱发送确认邮件，请查收完成更换（更换前登录邮箱不变）")
    }
    setEditingEmail(false)
    setEmailDraft("")
  }

  const initial2 = (name.trim() || email[0] || "?").slice(0, 1).toUpperCase()

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      {/* ---------- 头像 ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">头像</CardTitle>
          <CardDescription>
            png / jpg / webp，≤{formatLimit(TIERS.avatar.maxBytes)}，建议正方形
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          <Avatar className="size-24 rounded-full">
            {avatarKey && <AvatarImage src={avatarUrl(avatarKey)} alt={name || "头像"} />}
            <AvatarFallback className="rounded-full text-2xl">{initial2}</AvatarFallback>
          </Avatar>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={avatarBusy}
              onClick={() => setAvatarOpen(true)}
            >
              <PencilIcon className="size-3.5" />
              {avatarKey ? "更换头像" : "上传头像"}
            </Button>
            {avatarKey && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setRemoveAsk(true)}>
                <Trash2Icon className="size-3.5 text-destructive" />
                移除
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---------- 基本信息 ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">基本信息</CardTitle>
          <CardDescription>
            有生效教研组长任命时不可换校；解除学校绑定前需先撤销学校管理员身份。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="profile-name">姓名</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder="你的姓名"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>邮箱</Label>
            {!editingEmail ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input px-2.5 text-sm">
                  <MailIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{email}</span>
                </span>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditingEmail(true)}>
                  <PencilIcon className="size-3.5" /> 修改邮箱
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  type="email"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  placeholder="新邮箱"
                  onKeyDown={(e) => e.key === "Enter" && doChangeEmail()}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={emailBusy || !emailDraft.trim()}
                  onClick={doChangeEmail}
                >
                  {emailBusy && <Loader2Icon className="size-4 animate-spin" />}
                  确认
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={emailBusy}
                  onClick={() => {
                    setEditingEmail(false)
                    setEmailDraft("")
                  }}
                >
                  取消
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              更换邮箱需经验证（开启邮箱验证时向新邮箱发送确认邮件）。
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label>所属学校</Label>
            <Select
              value={school || NONE_SCHOOL}
              onValueChange={(v) => setSchool(v === NONE_SCHOOL ? "" : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="未绑定学校" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_SCHOOL}>未绑定学校</SelectItem>
                {schools.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!initial.schoolId && (
              <p className="text-xs text-amber-600">尚未绑定学校：绑定后才能出题与参与共建。</p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <span className="text-xs text-muted-foreground">用户 ID：{userId}</span>
            <Button type="button" disabled={!canSave || saving} onClick={doSaveBasic}>
              {saving && <Loader2Icon className="size-4 animate-spin" />}
              保存修改
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 头像上传（直传 OSS avatars/…，成功后立即落库） */}
      <MediaUploaderDialog
        purpose="avatar"
        open={avatarOpen}
        onOpenChange={setAvatarOpen}
        title="更换头像"
        onUploaded={async (meta) => {
          setAvatarBusy(true)
          const ok = await saveProfile({ avatarKey: meta.key })
          setAvatarBusy(false)
          if (ok) setAvatarOpen(false)
        }}
      />

      {/* 移除头像确认 */}
      <AlertDialog open={removeAsk} onOpenChange={setRemoveAsk}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除当前头像？</AlertDialogTitle>
            <AlertDialogDescription>
              移除后将以姓名首字占位显示，并删除 OSS 上已上传的头像文件（不可恢复）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                saveProfile({ avatarKey: null }).then((ok) => ok && setRemoveAsk(false))
              }}
            >
              确认移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
