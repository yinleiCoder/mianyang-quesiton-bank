"use client"

// /admin/reviews 行列表：等待中的任务可直接转派/指派给任一用户（DB 校验管理员身份与约束）。
import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { approvalStateChip } from "@/lib/admin-records"
import { fmtDateTime } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2Icon, SendIcon } from "lucide-react"
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

export function ReviewHistoryList({ rows, users }) {
  const router = useRouter()
  const [target, setTarget] = useState(null) // { approvalId, assignedName }
  const [toUser, setToUser] = useState("")
  const [busy, setBusy] = useState(false)

  async function runTransfer() {
    if (!target || !toUser) return
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.rpc("transfer_approval", {
      p_approval_id: target.approvalId,
      p_to_user: toUser,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("任务已转派")
    setTarget(null)
    setToUser("")
    router.refresh()
  }

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
          该状态下暂无审批记录
        </p>
      ) : (
        rows.map((r) => {
          const chip = approvalStateChip(r.state)
          const transferable = r.state === "waiting"
          return (
            <div key={r.id} className="rounded-xl border bg-card p-3 sm:p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={`inline-flex rounded px-1.5 py-0.5 font-medium ${chip.cls}`}>{chip.text}</span>
                    <Badge variant="outline" className="px-1.5 py-0 text-xs">
                      {r.kindLabel}
                    </Badge>
                    {r.stage && <span className="rounded bg-muted px-1.5 py-0.5">{r.stageLabel}</span>}
                    {r.qtypeLabel && (
                      <span className="text-muted-foreground/80">
                        {r.qtypeLabel}
                        {r.difficultyLabel ? ` · 难度 ${r.difficultyLabel}` : ""}
                      </span>
                    )}
                    {r.versionNo != null && <span className="text-muted-foreground/60">v{r.versionNo}</span>}
                    <span className="text-muted-foreground/60">{fmtDateTime(r.createdAt)}</span>
                  </div>

                  <p className="line-clamp-2 text-sm text-foreground/90">
                    {r.summary || <span className="text-muted-foreground">（题干为空）</span>}
                  </p>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="truncate">{r.nodePath || "未选节点"}</span>
                    {(r.schoolName || r.creatorName) && (
                      <span>
                        {r.schoolName}
                        {r.creatorName ? ` · 作者 ${r.creatorName}` : ""}
                      </span>
                    )}
                  </div>

                  {r.state === "waiting" ? (
                    <p className="text-xs">
                      {r.assignedUserId ? (
                        <>
                          处理人：<span className="font-medium text-foreground">{r.assignedName || "（已注销用户）"}</span>
                        </>
                      ) : (
                        <span className="font-medium text-amber-600">待指派（暂无处理人）</span>
                      )}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {r.decidedByName ? `由 ${r.decidedByName} 于 ${fmtDateTime(r.decidedAt)} 处理` : "（系统取消）"}
                      {r.assignedName ? ` · 处理人 ${r.assignedName}` : ""}
                    </p>
                  )}
                  {r.comment && (
                    <p className="whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                      批注：{r.comment}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={<Link href={`/review/${r.id}`} />}
                  >
                    看任务
                  </Button>
                  {transferable && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setTarget({ approvalId: r.id, assignedName: r.assignedName || "（无人）" })
                        setToUser(r.assignedUserId ?? "")
                      }}
                    >
                      <SendIcon className="size-3.5" /> 转派
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )
        })
      )}

      {/* 条件挂载（React Compiler 惯例）；转派对话框 */}
      {target && (
        <AlertDialog open onOpenChange={(v) => !v && !busy && setTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>转派审批任务</AlertDialogTitle>
              <AlertDialogDescription className="whitespace-pre-wrap">
                任务当前处理人：{target.assignedName}。转派后原处理人的待办消失、新处理人可见该任务；
                需具备对应环节身份（组长/专家）才能正常审核。作者本人不可作为目标。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <select
              value={toUser}
              onChange={(e) => setToUser(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
            >
              <option value="">选择目标用户…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.schoolName ? `（${u.schoolName}）` : "（未绑定学校）"}
                </option>
              ))}
            </select>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy || !toUser}
                onClick={(e) => {
                  e.preventDefault()
                  runTransfer()
                }}
              >
                {busy && <Loader2Icon className="size-4 animate-spin" />}
                确认转派
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
