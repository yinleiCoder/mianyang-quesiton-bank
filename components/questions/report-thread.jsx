"use client"

// 反馈 / 申诉的往来消息（0084）。三方共用：提交人 · 本题作者 · 本题审题人。
// 收件箱（处理人视角）与题目页（提交人视角）都用它，所以放在中立位置。
//
// 结案后不能再发言（服务端 can_post_question_report_message 同款判定）——
// 终态就该有终态的样子。这里只是提前把输入框收掉，别让人白打一段字。
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { loadReportMessages } from "@/lib/question-reports"
import { fmtDateTime24 } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Loader2Icon, SendIcon, UndoIcon } from "lucide-react"
import { SkeletonRows } from "@/components/ui/skeletons"

const MAX_LEN = 1000

export function ReportThread({ reportId, isOpen, canWithdraw = false, onChanged }) {
  const router = useRouter()
  const [messages, setMessages] = useState(null) // null = 加载中
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)

  async function reload() {
    try {
      setMessages(await loadReportMessages(createClient(), reportId))
    } catch {
      // 看不见就当作空：这条反馈本来就不该出现在当前用户面前时，服务端已经拦过了
      setMessages([])
    }
  }

  useEffect(() => {
    let alive = true
    loadReportMessages(createClient(), reportId)
      .then((rows) => alive && setMessages(rows))
      .catch(() => alive && setMessages([]))
    return () => {
      alive = false
    }
  }, [reportId])

  async function send() {
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    const { error } = await createClient().rpc("post_question_report_message", {
      p_report_id: reportId,
      p_body: text,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    setBody("")
    await reload()
    // 让宿主页面重算（收件箱的"待处理"计数、题目页的状态标签都跟着变）
    router.refresh()
    onChanged?.()
  }

  async function withdraw() {
    setBusy(true)
    const { error } = await createClient().rpc("withdraw_question_report", {
      p_report_id: reportId,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("已撤回这条反馈")
    router.refresh()
    onChanged?.()
  }

  return (
    <div className="mt-3 border-t pt-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          往来{messages ? `（${messages.length}）` : ""}
        </span>
        {canWithdraw && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" disabled={busy}>
                  <UndoIcon className="size-3.5" /> 撤回
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>撤回这条反馈？</AlertDialogTitle>
                <AlertDialogDescription>
                  撤回后这条反馈关闭、不会再有人处理它（想反悔可以重新提一条）。已经说过的往来消息会保留。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault()
                    withdraw()
                  }}
                >
                  {busy && <Loader2Icon className="size-4 animate-spin" />}
                  确认撤回
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {messages === null ? (
        <div className="mt-2">
          <span className="sr-only">往来消息加载中</span>
          <SkeletonRows rows={2} />
        </div>
      ) : messages.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">还没有往来消息。</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {messages.map((m) => (
            <li key={m.id} className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {m.author?.name ?? "账号已注销"}
                </span>
                {m.author?.identity === "teacher" && <span>教师</span>}
                <span className="ml-auto">{fmtDateTime24(m.created_at)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ul>
      )}

      {isOpen ? (
        <div className="mt-2 space-y-1.5">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            minRows={2}
            maxLength={MAX_LEN}
            placeholder="补充说明、回应对方的疑问…"
            aria-label="往来消息"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {body.trim().length}/{MAX_LEN}
            </span>
            <Button size="sm" disabled={busy || !body.trim()} onClick={send}>
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
              发送
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">这条反馈已结案，不能再回复。</p>
      )}
    </div>
  )
}
