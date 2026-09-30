"use client"

// 题目反馈收件箱（作者 / 学校管理员处理学生纠错、作者与审题人判定教师申诉的地方）。
//
// 两类东西共用这个收件箱（0084），靠提交人身份区分：
//   · 学生纠错 → 「处理」：写一句说明标记已处理（学生能看到这句话）
//   · 教师申诉 → 「受理并下线 / 驳回」：受理 = 题**立即下线**，等作者改版重走审批
// 服务端两条路各有守卫（申诉不能用 resolve，学生纠错不能用 judge），这里只是
// 显示对应的按钮，别让人白跑一趟。
//
// 改版走既有的 /questions/[id]/revise（两级审批链），**不在这里绕过审批** ——
// 已入库题目对全省可见，能改它的只有审批过的版本。
import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import {
  isAppealReport,
  reportCategoryLabel,
  reportStateChip,
} from "@/lib/question-reports"
import { ReportThread } from "@/components/questions/report-thread"
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
import { CheckIcon, Loader2Icon, MessagesSquareIcon, PencilIcon } from "lucide-react"

export function ReportInbox({ rows, status }) {
  const [target, setTarget] = useState(null) // 学生纠错：处理弹窗
  const [judging, setJudging] = useState(null) // 教师申诉：{ report, accept }

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
          <ReportRow
            key={r.id}
            report={r}
            onResolve={() => setTarget(r)}
            onJudge={(accept) => setJudging({ report: r, accept })}
          />
        ))}
      </ul>
      {target && <ResolveDialog report={target} onClose={() => setTarget(null)} />}
      {judging && (
        <JudgeDialog
          report={judging.report}
          accept={judging.accept}
          onClose={() => setJudging(null)}
        />
      )}
    </>
  )
}

function ReportRow({ report: r, onResolve, onJudge }) {
  const appeal = isAppealReport(r)
  const chip = reportStateChip(r.status, { questionState: r.question_state })
  // 开放中的申诉默认展开往来：判定前要看的就是对话本身；
  // 学生纠错数量多，默认收起，要看再点。
  const [showThread, setShowThread] = useState(appeal && r.status === "open")
  const router = useRouter()
  return (
    <li className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs ${chip.cls}`}>{chip.text}</span>
        {appeal && (
          <Badge className="bg-sky-100 text-xs text-sky-700">教师申诉</Badge>
        )}
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

      {/* 终态说明：学生纠错的「回复」与申诉的「判定」都落在这个字段上 */}
      {r.status !== "open" && r.status !== "withdrawn" && r.resolve_note && (
        <p className="mt-3 border-t pt-2 text-sm">
          <span className="text-muted-foreground">
            {r.resolver?.name ?? "管理员"} {appeal ? "判定" : "回复"}：
          </span>
          {r.resolve_note}
          <span className="ml-2 text-xs text-muted-foreground">{fmtDate(r.resolved_at)}</span>
        </p>
      )}
      {r.status === "withdrawn" && (
        <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">提交人已撤回。</p>
      )}

      {r.status === "open" && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
          {appeal ? (
            <>
              <Button size="sm" onClick={() => onJudge(true)}>
                <CheckIcon className="size-4" /> 受理并下线
              </Button>
              <Button size="sm" variant="outline" onClick={() => onJudge(false)}>
                驳回
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={onResolve}>
                <CheckIcon className="size-4" /> 处理
              </Button>
              {/* 要改内容就跳去改版 —— 走既有的两级审批，不在这里绕过 */}
              <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/questions/${r.question_id}/revise`} />}>
                <PencilIcon className="size-4" /> 发起改版
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShowThread((v) => !v)}>
            <MessagesSquareIcon className="size-4" />
            {showThread ? "收起往来" : "往来"}
          </Button>
        </div>
      )}

      {showThread && (
        <ReportThread
          reportId={r.id}
          isOpen={r.status === "open"}
          onChanged={() => router.refresh()}
        />
      )}
    </li>
  )
}

// 申诉判定（0084）。受理 = 立即下线 + 作者改版重走审批；驳回 = 说明理由。
// 两条都要写字：这是申诉人（以及其他审题人）唯一的回音，与服务端 judge_question_report
// 的强制口径一致。
function JudgeDialog({ report, accept, onClose }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    const text = note.trim()
    if (busy || !text) return
    setBusy(true)
    const { error } = await createClient().rpc("judge_question_report", {
      p_report_id: report.id,
      p_accept: accept,
      p_note: text,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(
      accept
        ? "已受理：这道题已下线，等作者改版后重走审批"
        : "已驳回，申诉人能看到你写的理由"
    )
    onClose()
    router.refresh()
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <div className="space-y-4">
          <DialogHeader>
            <DialogTitle>{accept ? "受理这条申诉" : "驳回这条申诉"}</DialogTitle>
            <DialogDescription>
              {accept
                ? "受理后这道题立即下线，学生不会再练到它；作者需要发起改版、重走两级审批，新版本入库时会自动恢复上线。"
                : "驳回表示核对后认为题目没有问题。写清楚理由 —— 申诉人和其他审题人都会看到这句话。"}
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
            <Label htmlFor="judge-note">判定说明</Label>
            <Textarea
              id="judge-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              minRows={3}
              maxLength={500}
              placeholder={
                accept
                  ? "例如：已核对，答案确实与解析矛盾，先下线，请作者改版后重走审批。"
                  : "例如：题干条件完整，按解析步骤算出来就是 B，答案无误。"
              }
            />
          </div>

          <DialogFooter>
            <Button type="button" disabled={busy || !note.trim()} onClick={submit}>
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              {accept ? "确认受理并下线" : "确认驳回"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
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
