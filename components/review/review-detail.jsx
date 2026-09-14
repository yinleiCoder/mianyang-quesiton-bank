"use client"

// 钉钉式审批详情：步骤条（提交→组长→专家→入库）＋ 历史时间线 ＋ 题目全量渲染（含答案）
// ＋ 决策动作（通过/退回必填意见/转派）。退回后作者修改可重提 → 全链重启，历史步骤以时间线呈现。
import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { statusChip } from "@/lib/question-model"
import { fmtDateTime24 } from "@/lib/format"
import { QuestionView } from "@/components/questions/question-view"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
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
} from "@/components/ui/alert-dialog"
import { Loader2Icon } from "lucide-react"

/* ---------- 步骤状态推导（content 任务） ---------- */
function deriveChain(v, timeline) {
  // RLS 只暴露与当前用户相关的行：组长看不到专家的待办行、专家看不到组长的通过行。
  // 步骤条按可见行 + 版本状态兜底推导，缺行 ≠ 流程断。
  const byTime = timeline
    .filter((t) => t.kind === "content")
    .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)))
  const last = (stage) => byTime.findLast((t) => t.stage === stage) ?? null
  const group = last("group")
  const city = last("city")
  const published = v && (v.status === "published" || v.status === "superseded")
  // 撤回/重审的取消行只在它是当前最新事件时提示（旧代际的取消历史留在时间线里）
  const cancelledBy = byTime.at(-1)?.state === "cancelled" ? byTime.at(-1) : null
  return { group, city, published, cancelledBy }
}

// 审批行 → 步骤状态：已决按结果，未决即"当前待办"，无行时用兜底值
function stepState(row, fallback = "") {
  if (!row) return fallback
  if (row.state === "approved") return "done"
  if (row.state === "returned") return "halted"
  return "current"
}

function StepDot({ done, current, halted }) {
  const cls = done
    ? "bg-emerald-500 text-white border-emerald-500"
    : halted
      ? "bg-rose-100 text-rose-600 border-rose-300"
      : current
        ? "border-amber-400 bg-amber-50 text-amber-600 ring-4 ring-amber-100"
        : "border-muted-foreground/30 text-muted-foreground/50"
  return (
    <span
      className={`flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${cls}`}
    >
      {done ? "✓" : halted ? "✕" : ""}
    </span>
  )
}

function StepBox({ label, state, by, at, comment, children }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-2 text-center">
      <StepDot
        done={state === "done"}
        halted={state === "halted"}
        current={state === "current"}
      />
      <div className="space-y-0.5">
        <p className={`text-xs font-medium ${state === "current" ? "text-amber-600" : ""}`}>{label}</p>
        {state === "current" && <p className="text-xs font-semibold text-amber-600">待处理</p>}
        {state === "halted" && <p className="text-xs font-medium text-rose-600">已退回</p>}
        {state === "done" && by && (
          <p className="text-xs text-muted-foreground">
            {by}
            {at ? <span className="block">{fmtDateTime24(at)}</span> : null}
          </p>
        )}
        {comment && <p className="line-clamp-3 max-w-56 text-xs text-muted-foreground">“{comment}”</p>}
      </div>
      {children}
    </div>
  )
}

function Connector({ done }) {
  return <div className={`h-0.5 min-w-4 flex-1 rounded ${done ? "bg-emerald-400" : "bg-border"}`} />
}

export function ReviewDetail({ data }) {
  const router = useRouter()
  const a = data.approval
  const v = data.version
  const [busy, setBusy] = React.useState("") // "" | pass | return | transfer
  const [returnOpen, setReturnOpen] = React.useState(false)
  const [transferOpen, setTransferOpen] = React.useState(false)
  const [comment, setComment] = React.useState("")
  const [targetId, setTargetId] = React.useState("")

  // 打开退回对话框时重置意见
  const openReturn = () => {
    setComment("")
    setReturnOpen(true)
  }

  async function decide(pass) {
    // 通过/退回各自的按钮要显示自己的加载态（否则退回时「通过」按钮在转圈、退回按钮毫无反馈）
    setBusy(pass ? "pass" : "return")
    const supabase = createClient()
    const { error } = await supabase.rpc("review_decide", {
      p_approval_id: a.id,
      p_pass: pass,
      p_comment: pass ? null : comment,
    })
    setBusy("")
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(pass ? "已通过，任务流转至下一环节" : "已退回，版本回到作者")
    setReturnOpen(false)
    router.refresh()
  }

  async function transfer() {
    if (!targetId) return
    setBusy("transfer")
    const supabase = createClient()
    const { error } = await supabase.rpc("transfer_approval", {
      p_approval_id: a.id,
      p_to_user: targetId,
    })
    setBusy("")
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("已转派")
    setTransferOpen(false)
    router.refresh()
  }

  const chain = a.kind === "content" ? deriveChain(v, data.timeline) : null
  const versionChip = v ? statusChip(v.status) : null
  const noAssignee = a.state === "waiting" && !a.assignedUserId

  // 转派目标不可为作者本人或当前处理人
  const notTargetable = (c) =>
    c.user_id === a.assignedUserId || c.user_id === data.question.creatorId
  const candidates = data.candidates.filter((c) => !notTargetable(c))

  // 默认值：首个非本人者，取一次即可。放在打开对话框的处理器里算——
  // 用 effect 依赖 data.candidates 的话，父层一旦换新数组就会把用户已选的目标冲掉。
  const openTransfer = () => {
    const pick = candidates.find((c) => c.user_id !== data.meId) ?? candidates[0]
    setTargetId(pick?.user_id ?? "")
    setTransferOpen(true)
  }

  return (
    <div className="space-y-4">
      {/* 头部：位置 + 基础信息 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{a.stageLabel}环节 · {a.kindLabel}</h1>
            {v && <Badge variant="secondary">{v.qtypeLabel}</Badge>}
            {v && (
              <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${versionChip.cls}`}>
                {versionChip.text}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {data.question.nodePath} · {data.question.schoolName} · {data.question.creatorName} 提交
            {v ? ` · v${v.versionNo} · 难度 ${v.difficultyLabel}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => router.back()}>
            返回
          </Button>
        </div>
      </div>

      {/* 待指派提示（管理员可见转派） */}
      {noAssignee && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          该任务暂无处理人（可能因任命缺失/唯一候选冲突）。请转派给可用{data.approval.stage === "group" ? "组长" : "专家"}
          {data.canTransfer ? "，或由管理员在下方操作。" : "，请联系系统管理员。"}
        </div>
      )}

      {/* 审批人操作条 */}
      {data.canAct && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5">
          <p className="mr-auto text-sm">
            当前任务处理人：<span className="font-medium">{a.assignedName || data.selfName}</span>
            <span className="ml-2 text-xs text-muted-foreground">通过可附意见；退回须填意见</span>
          </p>
          <Button size="sm" variant="outline" onClick={openTransfer} disabled={Boolean(busy)}>
            转派
          </Button>
          <Button size="sm" variant="destructive" onClick={openReturn} disabled={Boolean(busy)}>
            {busy === "return" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            退回
          </Button>
          <Button size="sm" onClick={() => decide(true)} disabled={Boolean(busy)}>
            {busy === "pass" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            通过
          </Button>
        </div>
      )}

      {/* 步骤条 */}
      <div className="rounded-xl border p-4">
        {a.kind === "content" && chain ? (
          <div className="flex items-start">
            <StepBox label="教师提交" state="done" by={data.question.creatorName} at={v?.submittedAt} />
            <Connector done />
            <StepBox
              label="教研组长审核"
              // 组长行不可见但已进专家环节 → 视为已通过
              state={stepState(chain.group, chain.city ? "done" : "current")}
              by={chain.group?.decidedByName}
              at={chain.group?.decidedAt}
              comment={chain.group?.comment}
            />
            <Connector done={chain.group?.state === "approved"} />
            <StepBox
              label="市级专家审核"
              state={stepState(
                chain.city,
                chain.group?.state === "approved" || (chain.group?.state !== "returned" && chain.published)
                  ? "current"
                  : ""
              )}
              by={chain.city?.decidedByName}
              at={chain.city?.decidedAt}
              comment={chain.city?.comment}
            />
            <Connector done={chain.city?.state === "approved"} />
            <StepBox label="入库" state={chain.published ? "done" : ""} by={chain.published ? "系统" : null} at={v?.publishedAt} />
          </div>
        ) : (
          <div className="flex items-start">
            <StepBox label="发起申请" state="done" by={data.question.creatorName} at={a.createdAt} />
            <Connector done />
            <StepBox
              label={a.stageLabel}
              state={stepState(a)}
              by={a.decidedByName}
              at={a.decidedAt}
              comment={a.comment}
            />
            <Connector done={a.state === "approved"} />
            <StepBox label={`题目${a.kind === "offline" ? "下线" : "恢复上线"}`} state={a.state === "approved" ? "done" : ""} />
          </div>
        )}
        {/* 已退回/取消提示 */}
        {a.kind === "content" && v?.status === "returned" && (
          <p className="mt-3 text-xs text-rose-600">该版本已被退回，作者修改后重新提交将全链重审。</p>
        )}
        {a.kind === "content" && chain?.cancelledBy && !(v?.status === "returned") && (
          <p className="mt-3 text-xs text-muted-foreground">
            有任务因撤回/重审被取消（见下方时间线）。
          </p>
        )}
      </div>

      {/* 题目渲染（审核视角：含答案与解析） */}
      {v && (
        <div className="rounded-xl border p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge variant="outline">{a.kindLabel}</Badge>
            <span className="text-xs text-muted-foreground">
              {data.question.courseNodeName} · 知识点：{data.tags.length > 0 ? data.tags.join("、") : "（无）"}
            </span>
          </div>
          <QuestionView qtype={v.qtype} content={v.content} showAnswer />
        </div>
      )}

      {/* 历史时间线 */}
      <div className="rounded-xl border p-4">
        <p className="mb-3 text-sm font-medium">审批记录</p>
        {data.timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无可见记录</p>
        ) : (
          <ol className="relative space-y-4 border-l pl-5">
            {data.timeline.map((t) => {
              const isWaiting = t.state === "waiting"
              return (
                <li key={t.id} className="relative">
                  <span
                    className={`absolute -left-6.75 top-1 size-3 rounded-full border-2 bg-background ${
                      t.state === "approved"
                        ? "border-emerald-500"
                        : t.state === "returned"
                          ? "border-rose-500"
                          : "border-amber-400"
                    }`}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">
                      {t.stage === "group" ? "教研组长" : t.stage === "city" ? "市级专家" : ""}环节
                    </span>
                    <span className="text-muted-foreground">
                      {t.kind !== "content" ? `（${t.kind === "offline" ? "下线申请" : "恢复申请"}）` : ""}
                    </span>
                    {t.assignedName && !t.decidedBy && (
                      <span className="text-muted-foreground">
                        待处理 · {t.assignedName} {fmtDateTime24(t.createdAt)}
                      </span>
                    )}
                    {t.decidedByName && (
                      <span className="text-muted-foreground">
                        {t.state === "approved" ? "通过" : t.state === "returned" ? "退回" : "取消"} · {t.decidedByName}{" "}
                        {fmtDateTime24(t.decidedAt)}
                      </span>
                    )}
                    {isWaiting && <span className="text-xs text-amber-600">当前待办</span>}
                  </div>
                  {t.comment && <p className="mt-0.5 text-sm text-muted-foreground">“{t.comment}”</p>}
                </li>
              )
            })}
          </ol>
        )}
      </div>

      {/* 退回对话框（必填意见） */}
      {returnOpen && (
        <AlertDialog open onOpenChange={(o) => !o && !busy && setReturnOpen(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>退回该题目？</AlertDialogTitle>
              <AlertDialogDescription>
                退回后版本回到作者草稿态，作者按意见修改后可重新提交（从组长环节全链重审）。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="return-comment">退回意见（必填）</Label>
              <Textarea
                id="return-comment"
                rows={4}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="请说明需要修改的内容：题干表述、选项设置、答案或解析问题…"
                className="text-sm"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={Boolean(busy)}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={Boolean(busy) || comment.trim() === ""}
                onClick={(e) => {
                  e.preventDefault()
                  decide(false)
                }}
              >
                {busy === "return" && <Loader2Icon className="size-4 animate-spin" />}
                确认退回
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* 转派对话框 */}
      {transferOpen && (
        <AlertDialog open onOpenChange={(o) => !o && !busy && setTransferOpen(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>转派该任务</AlertDialogTitle>
              <AlertDialogDescription>
                转派后任务立即归属目标用户，在途快照不受后续任命调整影响。不能转派给作者本人。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="transfer-target">转派给</Label>
              {candidates.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  暂无可转派用户。{a.stage === "group" ? "请学校管理员先任命该校教研组长" : "请系统管理员先任命市级专家"}。
                </p>
              ) : (
                <select
                  id="transfer-target"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {candidates.map((c) => (
                    <option key={c.user_id} value={c.user_id}>
                      {c.name}
                      {c.schoolName ? `（${c.schoolName}）` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={Boolean(busy)}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={Boolean(busy) || !targetId}
                onClick={(e) => {
                  e.preventDefault()
                  transfer()
                }}
              >
                {busy === "transfer" && <Loader2Icon className="size-4 animate-spin" />}
                确认转派
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
