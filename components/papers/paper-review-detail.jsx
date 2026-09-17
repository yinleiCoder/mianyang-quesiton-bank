"use client"

// 试卷审批详情（客户端）。与题目的 review-detail 分开写而不是加一堆 if：
// 两者要展示的东西完全不同（题目看单题内容+标签，试卷看整卷+分值结构），
// 混在一个组件里只会得到一堆 target === 'paper' ? … : … 的分支。
import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { PaperSheet } from "@/components/papers/paper-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { fmtDateTime } from "@/lib/format"
import { round2 } from "@/lib/paper-model"
import { CheckIcon, XIcon, SendIcon, ExternalLinkIcon } from "lucide-react"

const STATE_CHIP = {
  waiting: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  returned: "bg-rose-100 text-rose-700",
  cancelled: "bg-muted text-muted-foreground",
}
const STATE_TEXT = { waiting: "待处理", approved: "已通过", returned: "已退回", cancelled: "已取消" }

export function PaperReviewDetail({ data }) {
  const router = useRouter()
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState(null) // 'pass' | 'return' | 'transfer'
  const [toUser, setToUser] = useState("")

  const { approval, paper, snapshot, timeline, candidates, meId, canAct, canTransfer } = data
  // 转派目标不能是池里已有的人（服务端也会拦，这里先筛掉免得选了才报错）
  const transferTargets = candidates.filter((c) => !(approval.assignedUserIds ?? []).includes(c.user_id))

  async function call(fn, args, okMsg) {
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(okMsg)
    setMode(null)
    setComment("")
    router.refresh()
    router.push("/review")
  }

  const decide = (pass) =>
    call(
      "review_decide_paper",
      { p_approval_id: approval.id, p_pass: pass, p_comment: comment.trim() || null },
      pass ? (approval.stage === "city" ? "已通过，试卷入库" : "已通过，转市级专家") : "已退回"
    )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {snapshot?.title ?? paper.title}
            <span className={`ml-2 align-middle rounded px-1.5 py-0.5 text-xs font-normal ${STATE_CHIP[approval.state]}`}>
              {STATE_TEXT[approval.state]}
            </span>
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{approval.kindLabel}</Badge>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{approval.stageLabel}环节</span>
            <span>第 {paper.versionNo} 版</span>
            <span>·</span>
            <span>{paper.nodePath || "未选科目"}</span>
            {paper.schoolName && <span>· {paper.schoolName}</span>}
            {paper.creatorName && <span>· 组卷 {paper.creatorName}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href={`/papers/${paper.id}`} />}>
            试卷详情 <ExternalLinkIcon className="size-3.5" />
          </Button>
          <Button variant="outline" nativeButton={false} render={<a href={`/print/paper/${paper.versionId}/answers`} target="_blank" rel="noreferrer" />}>
            打印答案
          </Button>
        </div>
      </div>

      {snapshot && (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          共 <b className="tabular-nums">{snapshot.items?.length ?? 0}</b> 题
          <span className="mx-2 text-muted-foreground">·</span>
          满分 <b className="tabular-nums">{round2(snapshot.total_score)}</b> 分
          <span className="mx-2 text-muted-foreground">·</span>
          考试时长 <b className="tabular-nums">{snapshot.duration_minutes}</b> 分钟
          {snapshot.target_score != null && (
            <>
              <span className="mx-2 text-muted-foreground">·</span>
              设定总分 {round2(snapshot.target_score)} 分
            </>
          )}
        </p>
      )}

      {/* 审批人视角：整卷连同答案与解析一起呈现，否则没法判断选材与配分是否合理 */}
      <div className="rounded-xl border bg-white p-6 text-black sm:p-8">
        {snapshot ? (
          <PaperSheet snapshot={snapshot} mode="answers" />
        ) : (
          <p className="py-10 text-center text-sm text-black/50">试卷版本内容不可读</p>
        )}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">审批流转</h2>
        <div className="space-y-2">
          {timeline.map((t) => (
            <div key={t.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded px-1.5 py-0.5 ${STATE_CHIP[t.state]}`}>{STATE_TEXT[t.state]}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">
                  {t.stage === "group" ? "教研组长" : "市级专家"}
                </span>
                <span className="text-muted-foreground">{fmtDateTime(t.createdAt)}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t.state === "waiting"
                  ? t.assignedUserIds.length > 0
                    ? `处理人：${t.assignedNames.join("、") || "（已注销用户）"}`
                    : "待指派（暂无处理人）"
                  : t.decidedByName
                    ? `由 ${t.decidedByName} 于 ${fmtDateTime(t.decidedAt)} 处理`
                    : "（系统取消）"}
              </p>
              {t.comment && (
                <p className="mt-1 whitespace-pre-wrap rounded bg-muted/50 px-2 py-1.5 text-xs">{t.comment}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      {approval.state === "waiting" && (canAct || canTransfer) && (
        <section className="space-y-3 rounded-xl border p-4">
          <h2 className="text-sm font-medium">处理</h2>
          {canAct ? (
            <>
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="审批意见（退回时必填，通过时可选）"
                rows={3}
              />
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => decide(true)}>
                  <CheckIcon className="size-4" />
                  {approval.stage === "city" ? "通过并入库" : "通过，转市级专家"}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!comment.trim()) {
                      toast.error("退回时必须填写审批意见")
                      return
                    }
                    decide(false)
                  }}
                >
                  <XIcon className="size-4" /> 退回
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">这个任务不在你的待办里。</p>
          )}

          {canTransfer && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-sm text-muted-foreground">转派给其他审核人</p>
              <div className="flex flex-wrap gap-2">
                <select
                  value={toUser}
                  onChange={(e) => setToUser(e.target.value)}
                  className="h-9 min-w-56 rounded-md border bg-transparent px-2 text-sm"
                >
                  <option value="">选择目标用户…</option>
                  {transferTargets.map((c) => (
                    <option key={c.user_id} value={c.user_id}>
                      {c.name}
                      {c.schoolName ? `（${c.schoolName}）` : ""}
                    </option>
                  ))}
                </select>
                <Button
                  variant="secondary"
                  disabled={busy || !toUser}
                  onClick={() =>
                    call(
                      "transfer_paper_approval",
                      { p_approval_id: approval.id, p_to_user: toUser },
                      "已转派"
                    )
                  }
                >
                  <SendIcon className="size-4" /> 转派
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
