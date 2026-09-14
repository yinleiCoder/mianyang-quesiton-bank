"use client"

// 意见反馈收件箱（系统管理员）：逐条查看 + 标记已处理 / 重新打开。
// 筛选在服务端做（?status=，见 app/(app)/admin/feedback/page.jsx），这里只管动作；
// 动作成功后 router.refresh()：列表与侧栏「未处理」角标一起刷新。
import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import {
  feedbackCategoryLabel,
  feedbackPlatformLabel,
  feedbackStateChip,
} from "@/lib/feedback"
import { fmtDateTime24 } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { PersonChip } from "@/components/bank/person-chip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CheckCircle2Icon, Loader2Icon, RotateCcwIcon } from "lucide-react"

export function FeedbackInbox({ rows }) {
  const router = useRouter()
  const [target, setTarget] = React.useState(null) // { id, nextStatus }
  const [note, setNote] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  async function handleConfirm() {
    if (!target) return
    setBusy(true)
    const { error } = await createClient().rpc("admin_set_feedback_status", {
      p_feedback_id: target.id,
      p_status: target.nextStatus,
      p_note: note.trim() || null,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(target.nextStatus === "resolved" ? "已标记为已处理" : "已重新打开")
    setTarget(null)
    setNote("")
    router.refresh()
  }

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <Row
          key={r.id}
          r={r}
          onAction={(nextStatus) => {
            setNote("")
            setTarget({ id: r.id, nextStatus })
          }}
        />
      ))}

      {target && (
        <Dialog open onOpenChange={(v) => !v && !busy && setTarget(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {target.nextStatus === "resolved" ? "标记为已处理" : "重新打开"}
              </DialogTitle>
              <DialogDescription>
                {target.nextStatus === "resolved"
                  ? "处理说明只留在收件箱里，提交人看不到（本功能没有回复流）；需要跟进的请按行上的联系方式线下联系。"
                  : "重新打开后该条回到「待处理」，侧栏角标会加回去。"}
              </DialogDescription>
            </DialogHeader>
            {target.nextStatus === "resolved" && (
              <div className="space-y-1.5">
                <Label htmlFor="feedback-note">处理说明（选填）</Label>
                <Textarea
                  id="feedback-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  minRows={3}
                  maxLength={200}
                  placeholder="例如：下个版本修复；已电话联系提交人说明。"
                />
              </div>
            )}
            <DialogFooter>
              <Button disabled={busy} onClick={handleConfirm}>
                {busy && <Loader2Icon className="size-4 animate-spin" />}
                确认
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function Row({ r, onAction }) {
  const chip = feedbackStateChip(r.status)
  const resolved = r.status === "resolved"
  return (
    <div className="rounded-xl border p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Badge variant="outline" className="px-1.5 py-0 text-xs">
          {feedbackCategoryLabel(r.category)}
        </Badge>
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${chip.cls}`}>{chip.text}</span>
        <span className="text-muted-foreground/80">{feedbackPlatformLabel(r.platform)}</span>
        {r.client_version && <span className="text-muted-foreground/60">v{r.client_version}</span>}
        <span className="text-muted-foreground/70">{fmtDateTime24(r.created_at)}</span>
        <span className="ml-auto">
          <PersonChip person={r.submitter} caption="提交人" />
        </span>
      </div>

      <p className="mt-2 text-sm whitespace-pre-wrap text-foreground/90">{r.content}</p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {r.contact && <span>联系方式：{r.contact}</span>}
        {resolved ? (
          <span className="text-emerald-700">
            已由 {r.resolver?.name || "（已注销）"} 于 {fmtDateTime24(r.resolved_at)} 处理
            {r.resolve_note ? `：${r.resolve_note}` : ""}
          </span>
        ) : (
          <span className="text-muted-foreground/70">未留联系方式时，可按提交人的账号邮箱联系</span>
        )}
        <span className="ml-auto">
          {resolved ? (
            <Button variant="ghost" size="sm" onClick={() => onAction("open")}>
              <RotateCcwIcon className="size-4" />
              重新打开
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => onAction("resolved")}>
              <CheckCircle2Icon className="size-4" />
              标记已处理
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}
