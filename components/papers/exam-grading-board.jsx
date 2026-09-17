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
import { fmtDateTime } from "@/lib/format"
import { round2 } from "@/lib/paper-model"
import { qtypeLabel } from "@/lib/question-model"
import { CheckIcon, Loader2Icon, RefreshCwIcon, ArrowLeftIcon, UsersIcon } from "lucide-react"

const STATUS_TEXT = { submitted: "待阅卷", grading: "阅卷中", graded: "已出分" }

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
  if (a.type === "unknown") return <Missing />

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
  if (a.type === "unknown") return <Missing />
  if (qtype === "single_choice" || qtype === "multiple_choice")
    return <span className="font-medium">{(a.keys ?? []).join("、") || "（未作答）"}</span>
  if (qtype === "true_false")
    return <span className="font-medium">{a.value === true ? "正确" : a.value === false ? "错误" : "（未作答）"}</span>
  if (qtype === "fill_blank") {
    const vals = a.values ?? []
    return vals.length === 0 ? (
      <Missing />
    ) : (
      <ol className="list-inside list-decimal space-y-0.5">
        {vals.map((v, i) => (
          <li key={i} className="whitespace-pre-wrap">
            {v || <span className="text-muted-foreground">（空）</span>}
          </li>
        ))}
      </ol>
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
            {item.score_units?.length > 1 ? "逐点给分" : "给分"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {units.map((u, i) => (
              <div key={i} className="flex items-center gap-1">
                {units.length > 1 && <span className="text-xs text-muted-foreground">{i + 1}.</span>}
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
        </div>
      </div>
    </div>
  )
}

export function ExamGradingBoard({ paperId, initialQueue }) {
  const supabase = createClient()
  const [queue, setQueue] = useState(initialQueue)
  const [onlyPending, setOnlyPending] = useState(true)
  const [current, setCurrent] = useState(null) // 阅卷详情 {attempt, paper, answers}
  const [loading, setLoading] = useState(false)

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

  return (
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
          只看还没判完的
        </label>

        <div className="space-y-1.5">
          {queue.length === 0 && (
            <p className="rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground">
              没有需要批阅的卷子
            </p>
          )}
          {queue.map((a) => (
            <button
              key={a.attempt_id}
              type="button"
              onClick={() => openAttempt(a.attempt_id)}
              className={`w-full rounded-lg border p-2.5 text-left text-sm transition-colors ${
                current?.attempt?.id === a.attempt_id ? "border-primary bg-primary/5" : "hover:bg-muted/50"
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{a.user_name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {STATUS_TEXT[a.status] ?? a.status}
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {fmtDateTime(a.submitted_at)}
                {a.pending_review_count > 0 ? ` · 还有 ${a.pending_review_count} 题待判` : ""}
              </span>
              <span className="mt-0.5 block text-xs">
                得分 <b className="tabular-nums">{round2(a.total_score)}</b> / {round2(a.full_score)}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="min-h-0 space-y-4">
        {loading && <p className="py-8 text-center text-sm text-muted-foreground">载入中…</p>}
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
                <p className="mt-0.5 text-sm">
                  当前得分 <b className="tabular-nums">{round2(current.attempt.total_score)}</b> /{" "}
                  {round2(current.attempt.full_score)} 分
                  {pendingLeft > 0 && (
                    <span className="ml-2 text-amber-600">还有 {pendingLeft} 题待判</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" render={<Link href={`/papers/${paperId}`} />} nativeButton={false}>
                  <ArrowLeftIcon className="size-4" /> 试卷详情
                </Button>
                <Button size="sm" onClick={finish} disabled={pendingLeft > 0 || current.attempt.status === "graded"}>
                  <CheckIcon className="size-4" />
                  {current.attempt.status === "graded" ? "已出分" : "出成绩"}
                </Button>
              </div>
            </div>

            {/* 主观题（简答，或含简答子题的复合题）的计分点在服务端就是 pending，
                客观题在这里只是复核——教师可以推翻自动判分 */}
            {rows
              .filter((r) => r.record?.grading === "pending" || r.item.qtype === "short_answer" || r.record?.grading === "manual")
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

            <details className="rounded-xl border p-4">
              <summary className="cursor-pointer text-sm font-medium">
                客观题自动判分（{rows.filter((r) => r.record?.grading === "auto").length} 题，点开复核）
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
  )
}
