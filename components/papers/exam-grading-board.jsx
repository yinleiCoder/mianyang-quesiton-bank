"use client"

// 阅卷工作台：左边是待判队列，右边是某一份卷子的逐题批改。
//
// 给分的粒度是**计分点**不是整题：一道三空的填空题就是三个输入框，
// 对两空给两空的分。这与卷面分值同源（paper_items.score_units），
// 所以「卷面上写每空 2 分」和「阅卷时每空给 2 分」永远是同一件事。
import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { QuestionView } from "@/components/questions/question-view"
import { AiGradeSuggest } from "@/components/papers/ai-grade-suggest"
import { GradingAssignmentPanel } from "@/components/papers/grading-assignment-panel"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { SkeletonRows } from "@/components/ui/skeletons"
import { fmtDateTime } from "@/lib/format"
import { round2, unitLabelsForItem } from "@/lib/paper-units"
import { qtypeLabel } from "@/lib/question-model"
import {
  assignAttempt,
  claimAllForPaper,
  claimAttempt,
  claimAttempts,
  loadAttemptCandidates,
  releaseAttempt,
} from "@/lib/grading-assignments"
import {
  CheckIcon,
  Loader2Icon,
  RefreshCwIcon,
  ArrowLeftIcon,
  UsersIcon,
  LockIcon,
  LockOpenIcon,
  UserRoundCogIcon,
} from "lucide-react"

const STATUS_TEXT = { submitted: "待阅卷", grading: "阅卷中", graded: "已出分" }

// 认领状态：公共池 / 我 / 其他老师。徽标只是展示，能不能操作由服务端 RPC 再判一次。
function claimStateOf(row, currentUserId) {
  if (!row?.claimed_by) return { text: "未认领", cls: "bg-amber-100 text-amber-800" }
  if (row.claimed_by === currentUserId) return { text: "我认领", cls: "bg-emerald-100 text-emerald-700" }
  return {
    text: row.claimed_by_name ?? "其他老师",
    cls: "bg-muted text-muted-foreground",
  }
}

// 考生作答的纯文本呈现（阅卷时看的是"他写了什么"）
//
// 形状由客户端提交时决定（Flutter 端 domain/submitted_answer.dart）：
//   choice → {keys} / true_false → {value} / fill_blank → {values}
//   主观题 → {text}（**学生手写的那段话就在这里**，不给教师看等于没法判）
//   composite → {subs:[…]}，逐子题按子题自己的题型渲染
// 复合题**必须逐子题展开**：它没有顶层答案，只看顶层会显示成「（未作答）」，
// 而那正是最需要教师逐子题给分的一种题。
function AnswerText({ item, answer }) {
  const a = answer ?? {}
  // 学生主动点了「不会」（客户端提交 {"type":"unknown"}）—— 与漏答不是一回事
  if (a.type === "unknown") return <span className="text-muted-foreground">（学生标记：不会）</span>

  if (item.qtype === "composite") {
    const subs = Array.isArray(a.subs) ? a.subs : []
    if (subs.length === 0) return <Missing />
    const types = (item.content?.sub ?? []).map((sub) => sub?.type)
    return (
      <ol className="list-inside list-decimal space-y-0.5">
        {subs.map((sub, i) => (
          <li key={i} className="whitespace-pre-wrap">
            <AnswerBody qtype={types[i]} answer={sub} />
          </li>
        ))}
      </ol>
    )
  }

  return <AnswerBody qtype={item.qtype} answer={a} />
}

function AnswerBody({ qtype, answer }) {
  const a = answer ?? {}
  // 学生主动点了「不会」（客户端提交 {"type":"unknown"}）—— 与漏答不是一回事
  if (a.type === "unknown") return <span className="text-muted-foreground">（学生标记：不会）</span>
  if (qtype === "single_choice" || qtype === "multiple_choice")
    return <span className="font-medium">{(a.keys ?? []).join("、") || "（未作答）"}</span>
  if (qtype === "true_false")
    return <span className="font-medium">{a.value === true ? "正确" : a.value === false ? "错误" : "（未作答）"}</span>
  if (qtype === "fill_blank") {
    const vals = a.values ?? []
    return vals.length === 0 ? (
      <Missing />
    ) : (
      // 每空用 (1)(2) 而不是 <ol> 的 1. 2.：复合题的**小问**已经用了 1. 2. 3.，
      // 里层再来一套 1. 2. 会变成「1. 2. 3. 1. 2. 4.」——阅卷时分不清哪个是第几题。
      <ul className="list-inside space-y-0.5">
        {vals.map((v, i) => (
          <li key={i} className="whitespace-pre-wrap">
            <span className="mr-1 text-muted-foreground tabular-nums">({i + 1})</span>
            {v || <span className="text-muted-foreground">（空）</span>}
          </li>
        ))}
      </ul>
    )
  }
  // 主观题：客户端存的是 {type:"text", text:"…"}；samples 是历史形状，一并认
  const samples = a.samples ?? a.text ?? []
  const text = Array.isArray(samples) ? samples.join("\n") : String(samples)
  return text ? <p className="whitespace-pre-wrap">{text}</p> : <Missing />
}

function Missing() {
  return <span className="text-muted-foreground">（未作答）</span>
}

function GradeRow({ item, record, onGraded }) {
  const unitLabelList = unitLabelsForItem(item, { compact: true })
  const [units, setUnits] = useState(() =>
    (item.score_units ?? [0]).map((u, i) => {
      const given = record?.units?.[i]
      return given?.score != null ? Number(given.score) : record?.grading === "pending" ? 0 : Number(u)
    })
  )
  const [comment, setComment] = useState(record?.comment ?? "")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // 切换卷子时把输入框重置成这一题的实际得分
    setUnits(
      (item.score_units ?? [0]).map((u, i) => {
        const given = record?.units?.[i]
        return given?.score != null ? Number(given.score) : record?.grading === "pending" ? 0 : Number(u)
      })
    )
    setComment(record?.comment ?? "")
  }, [record, item.score_units])

  const isPending = record?.grading === "pending"
  const total = round2(units.reduce((a, b) => a + Number(b || 0), 0))

  async function save() {
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.rpc("grade_exam_answer", {
      p_attempt_id: record.attempt_id,
      p_paper_item_id: item.id,
      p_units: units,
      p_comment: comment.trim() || null,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(`第 ${item.seq} 题已给 ${total} 分`)
    onGraded()
  }

  return (
    <div className={`rounded-xl border p-4 ${isPending ? "border-amber-300 bg-amber-50/40" : ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium tabular-nums">第 {item.seq} 题</span>
        <Badge variant="secondary" className="font-normal">
          {qtypeLabel(item.qtype)}
        </Badge>
        <span className="text-muted-foreground">
          满分 {round2(item.score)} 分{item.score_units?.length > 1 ? ` · ${item.score_units.length} 个给分点` : ""}
        </span>
        {isPending ? (
          <Badge className="bg-amber-100 font-normal text-amber-800">待阅卷</Badge>
        ) : (
          <Badge className="bg-emerald-100 font-normal text-emerald-700">
            {record?.grading === "manual" ? "教师给分" : "自动判分"} {round2(record?.score ?? 0)} 分
          </Badge>
        )}
      </div>

      <QuestionView qtype={item.qtype} content={item.content} showAnswer variant="paper" />

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border bg-card p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">考生作答</p>
          <div className="text-sm">
            <AnswerText item={item} answer={record?.answer} />
          </div>
        </div>

        <div className="rounded-lg border bg-card p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {item.score_units?.length > 1
              ? item.qtype === "composite"
                ? "逐点给分（小问-空）"
                : "逐点给分"
              : "给分"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {units.map((u, i) => (
              <div key={i} className="flex items-center gap-1">
                {units.length > 1 && (
                  <span className="text-xs text-muted-foreground">{unitLabelList[i] ?? i + 1}</span>
                )}
                <Input
                  type="number"
                  min="0"
                  step="0.5"
                  max={item.score_units?.[i] ?? 0}
                  value={u}
                  onChange={(e) => {
                    const next = [...units]
                    next[i] = e.target.value === "" ? 0 : Number(e.target.value)
                    setUnits(next)
                  }}
                  className="h-8 w-16"
                />
                <span className="text-xs text-muted-foreground">/ {round2(item.score_units?.[i] ?? 0)}</span>
              </div>
            ))}
            <span className="ml-auto text-sm">
              合计 <b className="tabular-nums">{total}</b> 分
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setUnits((item.score_units ?? []).map(Number))}>
              给满分
            </Button>
            <Button size="sm" variant="outline" onClick={() => setUnits((item.score_units ?? []).map(() => 0))}>
              给零分
            </Button>
            <Button size="sm" onClick={save} disabled={busy} className="ml-auto">
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : <CheckIcon className="size-4" />}
              保存本题给分
            </Button>
          </div>
          {(isPending || record?.grading === "manual") && (
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="评语（可选，考生能看到）"
              className="mt-2 h-8"
            />
          )}
          {isPending && (
            <AiGradeSuggest
              item={item}
              record={record}
              labels={unitLabelList}
              onApply={(nextUnits, nextComment) => {
                // 只填输入框；保存仍由教师点下面的「保存本题给分」。
                setUnits(nextUnits)
                if (nextComment) setComment(nextComment)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export function ExamGradingBoard({
  paperId,
  initialQueue,
  canManage = false,
  currentUserId = null,
}) {
  const supabase = createClient()
  const [queue, setQueue] = useState(initialQueue)
  const [onlyPending, setOnlyPending] = useState(true)
  // 默认**显示已批过的题**（2026-11-05 用户要求）：批完就消失的话，发现判错时
  // 那道题已经不在页面上，没法改分。现在批完仍留在原位、分数可编辑；
  // 想只看没批的，勾「只看待判」。
  const [onlyPendingRows, setOnlyPendingRows] = useState(false)
  const [current, setCurrent] = useState(null) // 阅卷详情 {attempt, paper, answers}
  const [loading, setLoading] = useState(false)
  const [claimBusy, setClaimBusy] = useState(null)
  // 改派对话框（管理员）
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignCandidates, setAssignCandidates] = useState([])
  const [assignLoading, setAssignLoading] = useState(false)
  const [assignTarget, setAssignTarget] = useState(null)
  const [assignBusy, setAssignBusy] = useState(false)
  // 公共池：筛选 + 多选 + 批量认领
  const [claimFilter, setClaimFilter] = useState("all") // all | pool | mine
  const [selected, setSelected] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const reloadQueue = useCallback(async () => {
    const { data, error } = await supabase.rpc("list_exam_attempts_for_paper", {
      p_paper_id: paperId,
      p_only_pending: onlyPending,
      p_limit: 100,
      p_offset: 0,
    })
    if (error) {
      toast.error(error.message)
      return
    }
    setQueue(data?.attempts ?? [])
  }, [supabase, paperId, onlyPending])

  const openAttempt = useCallback(
    async (attemptId) => {
      setLoading(true)
      const { data, error } = await supabase.rpc("get_exam_attempt_for_review", { p_attempt_id: attemptId })
      setLoading(false)
      if (error) {
        toast.error(error.message)
        return
      }
      setCurrent(data)
    },
    [supabase]
  )

  useEffect(() => {
    if (queue.length > 0 && !current) openAttempt(queue[0].attempt_id)
    // 只在首次拿到队列时自动打开第一份；之后由用户点选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue])

  // 题目 + 作答合并成批改行
  const rows = useMemo(() => {
    if (!current) return []
    const byItem = new Map((current.answers ?? []).map((a) => [a.paper_item_id, a]))
    return (current.paper?.items ?? []).map((it) => ({ item: it, record: byItem.get(it.id) }))
  }, [current])

  const pendingLeft = rows.filter((r) => r.record?.grading === "pending").length
  const pendingUnits = rows
    .filter((r) => r.record?.grading === "pending")
    .reduce((sum, r) => sum + (r.item.score_units?.length ?? 1), 0)
  const reviewRows = rows.filter(
    (r) =>
      r.record?.grading === "pending" ||
      r.record?.grading === "manual" ||
      r.item.qtype === "short_answer"
  )
  const visibleReviewRows = onlyPendingRows
    ? reviewRows.filter((r) => r.record?.grading === "pending")
    : reviewRows

  // 公共池 / 我的认领：队列里的 row 直接带 claimed_by，不需要再查一次。
  // 已出分（graded）的场次不能再认领，公共池只算待批的未认领场次。
  const poolRows = queue.filter((a) => !a.claimed_by && a.status !== "graded")
  const myRows = queue.filter((a) => a.claimed_by === currentUserId)
  const visibleQueue =
    claimFilter === "pool" ? poolRows : claimFilter === "mine" ? myRows : queue
  // 只有未认领且待批的场次能勾选/批量认领；别人的认领不给你操作。
  const selectableRows = visibleQueue.filter(
    (a) => !a.claimed_by && a.status !== "graded"
  )
  const allSelected =
    selectableRows.length > 0 && selectableRows.every((a) => selected.has(a.attempt_id))

  function switchClaimFilter(next) {
    setClaimFilter(next)
    setSelected(new Set())
  }

  function toggleSelect(attemptId) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(attemptId)) next.delete(attemptId)
      else next.add(attemptId)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        selectableRows.forEach((a) => next.delete(a.attempt_id))
      } else {
        selectableRows.forEach((a) => next.add(a.attempt_id))
      }
      return next
    })
  }

  async function claimSelected() {
    const ids = [...selected].filter((id) =>
      queue.some((a) => a.attempt_id === id && !a.claimed_by && a.status !== "graded")
    )
    if (ids.length === 0) return
    setBulkBusy(true)
    const { data, error } = await claimAttempts(ids)
    setBulkBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    const claimed = Number(data?.claimed ?? 0)
    const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : []
    setSelected(new Set())
    toast.success(
      `已认领 ${claimed} 场${conflicts.length > 0 ? `，${conflicts.length} 场已被别人认领` : ""}`
    )
    await reloadQueue()
    if (current?.attempt?.id) await openAttempt(current.attempt.id)
  }

  async function claimAll() {
    if (poolRows.length === 0) return
    setBulkBusy(true)
    const { data, error } = await claimAllForPaper(paperId)
    setBulkBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    setSelected(new Set())
    toast.success(`已认领 ${Number(data?.claimed ?? 0)} 场`)
    await reloadQueue()
    if (current?.attempt?.id) await openAttempt(current.attempt.id)
  }

  async function claim(attemptId) {
    setClaimBusy(attemptId)
    const { error } = await claimAttempt(attemptId)
    setClaimBusy(null)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("已认领，这份卷由你批完")
    await reloadQueue()
    await openAttempt(attemptId)
  }

  async function release(attemptId) {
    setClaimBusy(attemptId)
    const { error } = await releaseAttempt(attemptId)
    setClaimBusy(null)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("已释放回公共池")
    await reloadQueue()
    if (current?.attempt?.id === attemptId) await openAttempt(attemptId)
  }

  async function openAssign() {
    if (!current) return
    setAssignOpen(true)
    setAssignTarget(null)
    setAssignLoading(true)
    const { candidates, error } = await loadAttemptCandidates(current.attempt.id)
    setAssignLoading(false)
    if (error) {
      toast.error(error.message)
      return
    }
    setAssignCandidates(candidates)
  }

  async function doAssign() {
    if (!current || !assignTarget) return
    setAssignBusy(true)
    const { error } = await assignAttempt(current.attempt.id, assignTarget)
    setAssignBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("已改派")
    setAssignOpen(false)
    await reloadQueue()
    await openAttempt(current.attempt.id)
  }

  async function finish() {
    const { data, error } = await supabase.rpc("finish_exam_grading", { p_attempt_id: current.attempt.id })
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(`成绩已出：${data.total_score} / ${data.full_score} 分`)
    await openAttempt(current.attempt.id)
    await reloadQueue()
  }

  const currentClaim = claimStateOf(current?.attempt, currentUserId)
  const currentClaimedByMe = current?.attempt?.claimed_by === currentUserId
  const currentUnclaimed = !current?.attempt?.claimed_by
  const canFinishCurrent =
    canManage || currentUnclaimed || currentClaimedByMe

  return (
    <div className="space-y-4">
      {canManage && (
        <GradingAssignmentPanel
          paperId={paperId}
          onAssigned={async () => {
            await reloadQueue()
            if (current?.attempt?.id) await openAttempt(current.attempt.id)
          }}
        />
      )}

      <div className="grid min-h-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">
            <UsersIcon className="mr-1 inline size-4" />
            阅卷队列（{queue.length}）
          </h2>
          <Button size="icon-sm" variant="ghost" title="刷新" onClick={reloadQueue}>
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyPending}
            onChange={(e) => setOnlyPending(e.target.checked)}
            className="size-3.5"
          />
          只看待判
        </label>

        <div className="space-y-2">
          {/* 公共池 / 我的认领：让「还有哪些没被认领」一眼可见，而不是混在整列里 */}
          <div className="flex flex-wrap items-center gap-1">
            {[
              ["all", `全部 ${queue.length}`],
              ["pool", `公共池 ${poolRows.length}`],
              ["mine", `我的 ${myRows.length}`],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => switchClaimFilter(key)}
                className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
                  claimFilter === key
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/70"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {queue.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1.5">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  disabled={selectableRows.length === 0}
                  className="size-3.5"
                />
                全选
              </label>
              <Button
                size="sm"
                variant="outline"
                onClick={claimSelected}
                disabled={bulkBusy || selected.size === 0}
              >
                {bulkBusy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <LockIcon className="size-3.5" />
                )}
                认领选中（{selected.size}）
              </Button>
              <Button size="sm" onClick={claimAll} disabled={bulkBusy || poolRows.length === 0}>
                <CheckIcon className="size-3.5" />
                一键认领本卷全部
              </Button>
            </div>
          )}

          <div className="space-y-1.5">
            {visibleQueue.length === 0 && (
              <p className="rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground">
                {queue.length === 0
                  ? "没有需要批阅的卷子"
                  : claimFilter === "pool"
                    ? "公共池已清空（都被认领了）"
                    : claimFilter === "mine"
                      ? "你还没有认领任何场次"
                      : "没有需要批阅的卷子"}
              </p>
            )}
            {visibleQueue.map((a) => {
              const claim = claimStateOf(a, currentUserId)
              return (
                <div
                  key={a.attempt_id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openAttempt(a.attempt_id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      openAttempt(a.attempt_id)
                    }
                  }}
                  className={`flex w-full cursor-pointer gap-2 rounded-lg border p-2.5 text-left text-sm transition-colors ${
                    current?.attempt?.id === a.attempt_id
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50"
                  }`}
                >
                  {!a.claimed_by && a.status !== "graded" ? (
                    <input
                      type="checkbox"
                      checked={selected.has(a.attempt_id)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={() => toggleSelect(a.attempt_id)}
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-label={`选择 ${a.user_name}`}
                    />
                  ) : (
                    <span className="mt-0.5 size-3.5 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{a.user_name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {STATUS_TEXT[a.status] ?? a.status}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {[a.user_school_name, a.user_major_name].filter(Boolean).join(" · ") ||
                        "学校/专业未设置"}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {fmtDateTime(a.submitted_at)}
                      {a.pending_review_count > 0 ? ` · 还有 ${a.pending_review_count} 题待判` : ""}
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2 text-xs">
                      <span className={`rounded px-1.5 py-0.5 ${claim.cls}`}>{claim.text}</span>
                      <span>
                        得分 <b className="tabular-nums">{round2(a.total_score)}</b> /{" "}
                        {round2(a.full_score)}
                      </span>
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </aside>

      <main className="min-h-0 space-y-4">
        {loading && (
          <>
            <span className="sr-only">试卷载入中</span>
            <SkeletonRows rows={4} />
            <Skeleton className="h-56 rounded-xl" />
          </>
        )}
        {!loading && !current && (
          <p className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
            从左边选一份卷子开始批阅
          </p>
        )}
        {!loading && current && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-3">
              <div>
                <p className="font-medium">
                  {current.attempt.user_name}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {STATUS_TEXT[current.attempt.status] ?? current.attempt.status} · 交卷于{" "}
                    {fmtDateTime(current.attempt.submitted_at)}
                  </span>
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className={`rounded px-1.5 py-0.5 ${currentClaim.cls}`}>
                    {currentClaim.text}
                  </span>
                  {current.attempt.claimed_at ? (
                    <span>认领于 {fmtDateTime(current.attempt.claimed_at)}</span>
                  ) : null}
                  {[current.attempt.user_school_name, current.attempt.user_major_name]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="mt-0.5 text-sm">
                  当前得分 <b className="tabular-nums">{round2(current.attempt.total_score)}</b> /{" "}
                  {round2(current.attempt.full_score)} 分
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  已判 {rows.length - pendingLeft} / 共 {rows.length} 题
                  {pendingLeft > 0
                    ? ` · 还剩 ${pendingLeft} 题 / ${pendingUnits} 个给分点待判`
                    : " · 全部判完"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={onlyPendingRows}
                    onChange={(e) => setOnlyPendingRows(e.target.checked)}
                    className="size-3.5"
                  />
                  只看待判
                </label>
                {currentUnclaimed && current.attempt.status !== "graded" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => claim(current.attempt.id)}
                    disabled={claimBusy === current.attempt.id}
                  >
                    {claimBusy === current.attempt.id ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <LockIcon className="size-4" />
                    )}
                    认领
                  </Button>
                )}
                {!currentUnclaimed && (currentClaimedByMe || canManage) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => release(current.attempt.id)}
                    disabled={claimBusy === current.attempt.id}
                  >
                    <LockOpenIcon className="size-4" /> 释放
                  </Button>
                )}
                {canManage && current.attempt.status !== "graded" && (
                  <Button size="sm" variant="outline" onClick={openAssign} disabled={assignLoading}>
                    <UserRoundCogIcon className="size-4" />
                    {currentUnclaimed ? "分配" : "改派"}
                  </Button>
                )}
                <Button variant="outline" size="sm" render={<Link href={`/papers/${paperId}`} />} nativeButton={false}>
                  <ArrowLeftIcon className="size-4" /> 试卷详情
                </Button>
                <Button
                  size="sm"
                  onClick={finish}
                  disabled={pendingLeft > 0 || current.attempt.status === "graded" || !canFinishCurrent}
                >
                  <CheckIcon className="size-4" />
                  {current.attempt.status === "graded" ? "已出分" : "出成绩"}
                </Button>
              </div>
            </div>

            {/* 人工题：简答、填空、综合（含其客观子题）在服务端就是 pending；
                客观选择/判断仍自动判，折叠在下面供复核 */}
            {visibleReviewRows.map((r) => (
                <GradeRow
                  key={r.item.id}
                  item={r.item}
                  record={{ ...r.record, attempt_id: current.attempt.id }}
                  onGraded={async () => {
                    await openAttempt(current.attempt.id)
                    await reloadQueue()
                  }}
                />
              ))}

            <details className="rounded-xl border p-4">
              <summary className="cursor-pointer text-sm font-medium">
                客观题自动判分（选择/判断，{rows.filter((r) => r.record?.grading === "auto").length} 题，点开复核）
              </summary>
              <div className="mt-3 space-y-4">
                {rows
                  .filter((r) => r.record?.grading === "auto")
                  .map((r) => (
                    <GradeRow
                      key={r.item.id}
                      item={r.item}
                      record={{ ...r.record, attempt_id: current.attempt.id }}
                      onGraded={async () => {
                        await openAttempt(current.attempt.id)
                        await reloadQueue()
                      }}
                    />
                  ))}
              </div>
            </details>
          </>
        )}
      </main>
      </div>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>改派阅卷人</DialogTitle>
            <DialogDescription>
              只列出能批这一场的老师（本校同专业、该科目组长/专家或试卷管理员）。
              改派会覆盖当前认领，原认领人随后不能再改这份卷。
            </DialogDescription>
          </DialogHeader>

          {assignLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">正在加载可批老师…</p>
          ) : assignCandidates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              没有可改派的老师（考生学校/专业或试卷科目没匹配到）。
            </p>
          ) : (
            <Select value={assignTarget} onValueChange={setAssignTarget}>
              <SelectTrigger>
                <SelectValue placeholder="选择老师" />
              </SelectTrigger>
              <SelectContent>
                {assignCandidates.map((c) => (
                  <SelectItem key={c.user_id} value={c.user_id}>
                    {c.name}
                    {c.school_name ? `（${c.school_name}）` : ""}
                    {c.major_name ? ` · ${c.major_name}` : ""}
                    {c.expert_role === "group_leader"
                      ? " · 教研组长"
                      : c.expert_role === "city_expert"
                        ? " · 市级专家"
                        : ""}
                    {Number(c.claimed_pending) > 0 ? ` · 已认领 ${c.claimed_pending} 场` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              取消
            </Button>
            <Button onClick={doAssign} disabled={assignBusy || assignLoading || !assignTarget}>
              {assignBusy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <UserRoundCogIcon className="size-4" />
              )}
              确认改派
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
