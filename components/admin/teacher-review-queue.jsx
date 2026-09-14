"use client"

// 教师身份审核队列（0025）：注册时选「教师」的账号在此审核。
// 系统管理员可审全校；学校管理员仅能审本校（DB 侧 review_teacher_identity 有断言兜底）。
// 通过 → profiles.identity='teacher'（获得出题/审批等教师权限）；驳回 → 'student'（仅刷题）。
import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2Icon, ShieldCheckIcon } from "lucide-react"

export function TeacherReviewQueue({ pendingUsers = [] }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState("")

  async function decide(userId, approve) {
    setBusy(`${userId}:${approve ? "y" : "n"}`)
    const supabase = createClient()
    const { error } = await supabase.rpc("review_teacher_identity", {
      p_user_id: userId,
      p_approve: approve,
    })
    setBusy("")
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(approve ? "已通过教师身份审核" : "已驳回，该账号保持学生权限")
    router.refresh()
  }

  if (pendingUsers.length === 0) return null

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon className="size-4 text-amber-600" />
        <p className="text-sm font-medium">
          教师身份待审核（{pendingUsers.length}）
        </p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        审核通过后该账号获得出题与审批权限；驳回则保持学生权限（仅刷题练习）。
      </p>
      <div className="mt-3 space-y-2">
        {pendingUsers.map((u) => (
          <div
            key={u.user_id}
            className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2"
          >
            <span className="text-sm font-medium">{u.name}</span>
            <span className="text-xs text-muted-foreground">{u.email}</span>
            {u.schoolName ? (
              <Badge variant="outline">{u.schoolName}</Badge>
            ) : (
              <Badge variant="destructive">未绑定学校</Badge>
            )}
            <span className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => decide(u.user_id, true)}
              >
                {busy === `${u.user_id}:y` && (
                  <Loader2Icon className="size-3.5 animate-spin" />
                )}
                通过
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => decide(u.user_id, false)}
              >
                {busy === `${u.user_id}:n` && (
                  <Loader2Icon className="size-3.5 animate-spin" />
                )}
                驳回
              </Button>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground/80">
        未绑定学校的待审核账号仅系统管理员可审核。
      </p>
    </div>
  )
}
