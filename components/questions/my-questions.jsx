"use client"

// 我的题目工作台：状态筛选、行内操作（编辑/提交/撤回/删除）。数据自管理：SSR seed + 操作后浏览器重查。
import { useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { statusChip } from "@/lib/question-model"
import { WORKBENCH_FILTERS, loadMyQuestions } from "@/lib/question-workbench"
import { EmptyState } from "@/components/empty-state"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ClipboardListIcon,
  Loader2Icon,
  PenLineIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react"

const CONFIRM_TEXT = {
  submit: {
    title: "提交审核？",
    desc: (r) =>
      `提交后进入审核链：${r.nodeFrozen ? "（警告：科目节点已冻结，提交会被拒绝）" : "教研组长 → 市级专家 → 入库"}。退回后可修改再重提；审核中可撤回。`,
    action: "确认提交",
    busy: "正在提交…",
  },
  retract: {
    title: "撤回该提交？",
    desc: () => "撤回后题目回到草稿态，已等待中的审批任务将被取消；可修改后重新提交。",
    action: "确认撤回",
    busy: "正在撤回…",
  },
  delete: {
    title: "删除这道题目？",
    desc: () => "该题从未提交过，删除后不可恢复。",
    action: "确认删除",
    busy: "正在删除…",
  },
  offline: {
    title: "申请下线这道题？",
    desc: () =>
      "下线需经教研组长审批。通过后题目从共享题库撤下、全市教师不再可见；审批期间题目照常在用。",
    action: "确认申请下线",
    busy: "正在提交申请…",
  },
  restore: {
    title: "申请恢复上线？",
    desc: () =>
      "恢复需经教研组长审批。通过后题目重新对全市教师可见；线下期间内容不可改动。",
    action: "确认申请",
    busy: "正在提交申请…",
  },
}

export function MyQuestions({ initialRows, initialFilter = "all" }) {
  const [rows, setRows] = useState(initialRows)
  const [filter, setFilter] = useState(initialFilter)
  const [pending, setPending] = useState(null) // {kind, row}
  // 正在操作的行 id：单布尔会让整列表所有行一起转圈、一起禁用
  const [busyId, setBusyId] = useState(null)

  async function refresh() {
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return
    const { rows: next } = await loadMyQuestions(supabase, user.id)
    setRows(next)
  }

  async function run(kind) {
    if (!pending) return
    const { row } = pending
    const qid = row.question.id
    // 行内动作 → RPC 与参数（版本级：提交/撤回；题目级：删除/上下线申请）
    const action = {
      submit: { fn: "submit_question", arg: { p_version_id: row.working.id } },
      retract: { fn: "retract_question", arg: { p_version_id: row.working.id } },
      delete: { fn: "delete_question_draft", arg: { p_question_id: qid } },
      offline: {
        fn: "request_question_state_change",
        arg: { p_question_id: qid, p_offline: true },
      },
      restore: {
        fn: "request_question_state_change",
        arg: { p_question_id: qid, p_offline: false },
      },
    }[kind]

    setBusyId(qid)
    const supabase = createClient()
    const { error } = await supabase.rpc(action.fn, action.arg)
    setBusyId(null)
    setPending(null)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success({
      submit: "已提交审核",
      retract: "已撤回",
      delete: "已删除",
      offline: "下线申请已提交，等待教研组长审批",
      restore: "恢复申请已提交，等待教研组长审批",
    }[kind])
    await refresh()
  }

  const counts = useMemo(() => {
    const c = { all: rows.length }
    for (const f of WORKBENCH_FILTERS) if (f.key !== "all") c[f.key] = rows.filter((r) => f.match(r.displayState)).length
    return c
  }, [rows])

  const shown = useMemo(
    () => rows.filter((r) => (WORKBENCH_FILTERS.find((f) => f.key === filter) ?? WORKBENCH_FILTERS[0]).match(r.displayState)),
    [rows, filter]
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {WORKBENCH_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1 text-sm transition-colors ${
                filter === f.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {f.label} {counts[f.key] > 0 && <span className="opacity-70">{counts[f.key]}</span>}
            </button>
          ))}
        </div>
        <Button nativeButton={false} render={<Link href="/questions/new" />}>
          <PlusIcon className="size-4" /> 出题
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardListIcon}
          title="还没有题目"
          description="全市共建题库靠各校教师贡献。选择科目节点，用六种题型出一题试试；提交后由你校教研组长与市级专家两级审核入库。"
          action={
            <Button nativeButton={false} render={<Link href="/questions/new" />}>
              <PlusIcon className="size-4" /> 出第一题
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
          该状态下暂无题目
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((r) => (
            <Row
              key={r.question.id}
              row={r}
              busy={busyId === r.question.id}
              onAction={(kind) => setPending({ kind, row: r })}
            />
          ))}
        </div>
      )}

      {/* 条件挂载：pending=null 时不构造元素，避免 React Compiler 记忆化闭包在 null 上做缓存比较（TypeError） */}
      {pending && (
        <ConfirmDialog
          title={CONFIRM_TEXT[pending.kind].title}
          description={CONFIRM_TEXT[pending.kind].desc(pending.row)}
          confirmText={CONFIRM_TEXT[pending.kind].action}
          busy={busyId !== null}
          onConfirm={() => run(pending.kind)}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  )
}

function Row({ row, onAction, busy }) {
  const chip = statusChip(row.displayState)
  const editorHref = `/questions/${row.question.id}/edit`
  const reviseHref = `/questions/${row.question.id}/revise`
  const kind = row.working?.status ?? row.displayState
  const showSubmit = kind === "draft" || kind === "returned"
  const showRetract = kind === "pending_group" || kind === "pending_city"
  // 入库在线（无在流版本、无在途上下线申请）才可操作改版/下线
  const liveIdle = kind === "published" && !row.pendingStateReq
  const offlineIdle = row.displayState === "offline" && !row.pendingStateReq

  return (
    <div
      className={`rounded-xl border p-3 transition-colors sm:p-4 ${
        row.displayState === "returned" ? "border-rose-200 bg-rose-50/40" : ""
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${chip.cls}`}>
              {chip.text}
            </span>
            {row.qtypeLabel && (
              <Badge variant="outline" className="px-1.5 py-0 text-xs">
                {row.qtypeLabel}
              </Badge>
            )}
            {row.difficultyLabel && (
              <span className="text-muted-foreground/80">难度 {row.difficultyLabel}</span>
            )}
            {row.stateText && <span>{row.stateText}</span>}
            {row.schoolName && <span>{row.schoolName}</span>}
            {row.pendingStateReq === "offline" && <span className="text-amber-600">下线申请审批中…</span>}
            {row.pendingStateReq === "restore" && <span className="text-amber-600">恢复申请审批中…</span>}
            {row.nodeFrozen && row.displayState === "draft" && (
              <span className="text-amber-600">节点已冻结（无法提交）</span>
            )}
          </div>
          <p className="line-clamp-2 text-sm text-foreground/90">
            {row.summary || <span className="text-muted-foreground">（题干为空）</span>}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{row.nodePath || "未选节点"}</span>
            {row.tags.length > 0 &&
              row.tags.slice(0, 4).map((t, i) => (
                <Badge key={i} variant="secondary" className="px-1.5 py-0 text-xs">
                  {t}
                </Badge>
              ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {showSubmit && (
            <Button size="sm" variant="secondary" onClick={() => onAction("submit")} disabled={busy || row.nodeFrozen}>
              <SendIcon className="size-3.5" />
              {kind === "returned" ? "重新提交" : "提交审核"}
            </Button>
          )}
          {(kind === "draft" || kind === "returned") && (
            <Button size="sm" variant="outline" nativeButton={false} render={<Link href={editorHref} />}>
              <PenLineIcon className="size-3.5" />
              {kind === "returned" ? "按意见修改" : "编辑"}
            </Button>
          )}
          {showRetract && (
            <Button size="sm" variant="outline" onClick={() => onAction("retract")} disabled={busy}>
              <Undo2Icon className="size-3.5" /> 撤回
            </Button>
          )}
          {liveIdle && (
            <Button size="sm" variant="secondary" nativeButton={false} render={<Link href={reviseHref} />}>
              <RefreshCwIcon className="size-3.5" /> 改版
            </Button>
          )}
          {liveIdle && (
            <Button
              size="sm"
              variant="outline"
              title="申请下线：经教研组长审批后从共享题库撤下"
              onClick={() => onAction("offline")}
              disabled={busy}
            >
              下线
            </Button>
          )}
          {offlineIdle && (
            <Button
              size="sm"
              variant="outline"
              title="申请恢复：经教研组长审批后重新对全市可见"
              onClick={() => onAction("restore")}
              disabled={busy}
            >
              <RefreshCwIcon className="size-3.5" /> 恢复上线
            </Button>
          )}
          {row.canDelete && (
            <Button size="sm" variant="ghost" onClick={() => onAction("delete")} disabled={busy}>
              <Trash2Icon className="size-3.5" /> 删除
            </Button>
          )}
          {busy && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
        </div>
      </div>
    </div>
  )
}

