"use client"

// 题目反馈收件箱（作者 / 学校管理员处理学生纠错的地方）。
//
// 为什么处理动作要写一句说明才让提交：这是本功能与通用意见反馈最大的区别 ——
// 学生能看到这句回复（题目页的「我的反馈」）。作者只点一下"已处理"而不写字，
// 学生的观感和石沉大海没有区别，这个功能就白做了。服务端 resolve_question_report
// 也强制了这一条（不写会 raise），这里只是提前把按钮禁掉、别让人白跑一趟。
//
// 改版走既有的 /questions/[id]/revise（两级审批链），**不在这里绕过审批** ——
// 已入库题目对全市可见，能改它的只有审批过的版本。
import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { reportCategoryLabel, reportStateChip } from "@/lib/question-reports"
import { fmtDate } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CheckIcon, Loader2Icon, PencilIcon } from "lucide-react"

export function ReportInbox({ rows, status }) {
  const [target, setTarget] = useState(null)

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        {status === "open" ? "没有待处理的反馈。" : "这里还没有记录。"}
      </p>
    )
  }

  return (
    <>
      <ul className="space-y-3">
        {rows.map((r) => (
          <ReportRow key={r.id} report={r} onResolve={() => setTarget(r)} />
        ))}
      </ul>
      {target && (
        <ResolveDialog
          report={target}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  )
}

function ReportRow({ report: r, onResolve }) {
  return (
    <li className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs ${reportStateChip(r.status).cls}`}>
          {reportStateChip(r.status).text}
        </span>
        <span className="text-sm font-medium">{reportCategoryLabel(r.category)}</span>
        {/* 版本号：学生提的是 v3 的问题，而当前可能已经是 v4 了。
            不标出来，作者会拿旧版本的描述去对照新版本的内容，越看越糊涂。 */}
        <span
          className={
            "rounded px-1.5 py-0.5 text-xs " +
            (r.is_current_version
              ? "bg-muted text-muted-foreground"
              : "bg-amber-100 text-amber-700")
          }
        >
          v{r.version_no}
          {r.is_current_version ? "（当前版本）" : "（已被改版）"}
        </span>
        {r.question_state !== "live" && (
          <Badge variant="outline" className="text-xs">
            题目已下线
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{fmtDate(r.created_at)}</span>
      </div>

      <p className="mt-2 text-sm">{r.content}</p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>来自 {r.reporter?.name ?? "账号已注销"}</span>
        <Link
          href={`/bank/${r.question_id}`}
          className="underline underline-offset-2 hover:text-foreground"
        >
          查看这道题
        </Link>
        {r.course_node_path && <span className="truncate">{r.course_node_path}</span>}
      </div>

      {r.status === "resolved" ? (
        <p className="mt-3 border-t pt-2 text-sm">
          <span className="text-muted-foreground">
            {r.resolver?.name ?? "管理员"} 回复：
          </span>
          {r.resolve_note}
          <span className="ml-2 text-xs text-muted-foreground">{fmtDate(r.resolved_at)}</span>
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
          <Button size="sm" onClick={onResolve}>
            <CheckIcon className="size-4" /> 处理
          </Button>
          {/* 要改内容就跳去改版 —— 走既有的两级审批，不在这里绕过 */}
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/questions/${r.question_id}/revise`} />}>
            <PencilIcon className="size-4" /> 发起改版
          </Button>
        </div>
      )}
    </li>
  )
}

function ResolveDialog({ report, onClose }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    const text = note.trim()
    if (busy || !text) return
    setBusy(true)
    const { error } = await createClient().rpc("resolve_question_report", {
      p_report_id: report.id,
      p_status: "resolved",
      p_note: text,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("已回复，提交人能看到这句话")
    onClose()
    router.refresh()
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <div className="space-y-4">
          <DialogHeader>
            <DialogTitle>处理这条反馈</DialogTitle>
            <DialogDescription>
              写一句说明。**提交人会在这道题下面看到它** —— 这是他们收到的唯一回音。
              如果问题确实存在，请先「发起改版」，改版审批通过后再回来标记已处理。
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="text-xs text-muted-foreground">
              {reportCategoryLabel(report.category)} · v{report.version_no} ·{" "}
              {report.reporter?.name ?? "账号已注销"}
            </p>
            <p className="mt-1">{report.content}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="resolve-note">处理说明</Label>
            <Textarea
              id="resolve-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              minRows={3}
              maxLength={500}
              placeholder="例如：已核对，答案确实有误，已提交改版，新版本审批通过后会替换在线内容。"
            />
          </div>

          <DialogFooter>
            <Button type="button" disabled={busy || !note.trim()} onClick={submit}>
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              标记已处理
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
