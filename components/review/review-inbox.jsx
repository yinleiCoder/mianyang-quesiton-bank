"use client"

// 审批收件箱：我的待办（组长/专家环节统一）→ 处理入口到详情页；管理员多一个"管理"页签（可看全任务/待指派）。
// 市级专家另有「一键入库」：把待办里的 city 环节内容任务一次性通过（详见 lib/bulk-rpc.js 的逐条策略）。
import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { approvalStateChip } from "@/lib/admin-records"
import { fmtDateTime24 } from "@/lib/format"
import { bulkResultMessage, progressReporter, runEachRpc } from "@/lib/bulk-rpc"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/empty-state"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ArrowRightIcon, CheckCircle2Icon, CircleSlash2Icon, InboxIcon, RotateCcwIcon } from "lucide-react"

export function ReviewInbox({ mineRows, decidedRows, manageRows, canManage, publishableIds = [] }) {
  const router = useRouter()
  const [tab, setTab] = useState("mine")
  // 待入库的任务 id：以服务端为准（router.refresh() 后 prop 会换新），本页批量通过的
  // 记进 processed 摘掉——这样「别处已处理」的失败项也不会在按钮计数里阴魂不散
  const [processed, setProcessed] = useState([])
  const publishIds = publishableIds.filter((id) => !processed.includes(id))
  const [bulkOpen, setBulkOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null) // {done, total}

  async function publishAll() {
    const ids = publishIds
    if (ids.length === 0) return
    const supabase = createClient()
    setBusy(true)
    setProgress({ done: 0, total: ids.length })
    try {
      const { ok, failed } = await runEachRpc(
        ids,
        (approvalId) =>
          supabase.rpc("review_decide", {
            p_approval_id: approvalId,
            p_pass: true,
            p_comment: null,
          }),
        progressReporter(setProgress)
      )
      const failedIds = new Set(failed.map((f) => f.id))
      // 只有通过的才摘掉：失败的留在待办里，点开还能看到原因（多半是被别处处理过）
      setProcessed((prev) => [...prev, ...ids.filter((id) => !failedIds.has(id))])
      const text = bulkResultMessage("入库", ok, failed)
      if (failed.length > 0) toast.warning(text)
      else toast.success(text)
      router.refresh() // 待办/已处理两个页签的数据都来自服务端
    } catch (err) {
      toast.error(err?.message ?? "批量入库失败")
    } finally {
      setBusy(false)
      setProgress(null)
      setBulkOpen(false)
    }
  }
  // 页签 = 数据源 + 行态 + 空态文案；「管理」仅管理员可见
  const tabs = [
    {
      key: "mine",
      label: "我的待办",
      rows: mineRows,
      empty: { icon: InboxIcon, title: "没有待办任务", description: "审批任务到达后出现在这里（组长环节/专家环节统一收口）。" },
    },
    {
      key: "done",
      label: "已处理",
      rows: decidedRows,
      rowProps: { decided: true },
      empty: { icon: CheckCircle2Icon, title: "暂无已处理记录", description: "你作出的通过/退回决策会显示在这里，可随时回看。" },
    },
    ...(canManage
      ? [
          {
            key: "manage",
            label: "管理",
            rows: manageRows,
            rowProps: { manage: true },
            empty: { icon: CircleSlash2Icon, title: "无在途任务", description: "本范围内暂无等待中的审批任务。" },
          },
        ]
      : []),
  ]
  const current = tabs.find((t) => t.key === tab) ?? tabs[0]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-full px-3 py-1 text-sm transition-colors ${
                tab === t.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {t.label}
              {t.rows.length > 0 && <span className="ml-1 opacity-70">{t.rows.length}</span>}
            </button>
          ))}
        </div>
        {/* 一键入库：只在「我的待办」页签、且确有可入库任务时出现。
            可入库 = 市级专家环节的内容任务（见 lib/review-workbench.js），组长/教师恒为 0 */}
        {tab === "mine" && publishIds.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            title="把待办里市级专家环节的题目一次性通过：通过即入库、全市可见（等同逐题点「通过」）"
            onClick={() => setBulkOpen(true)}
            disabled={busy}
          >
            <CheckCircle2Icon className="size-3.5" /> 一键入库（{publishIds.length}）
          </Button>
        )}
      </div>

      {current.rows.length === 0 ? (
        <EmptyState {...current.empty} />
      ) : (
        <div className="space-y-2">
          {current.rows.map((r) => (
            <Row key={r.approval.id} r={r} {...current.rowProps} />
          ))}
        </div>
      )}

      {/* 批量确认（条件挂载）：进度写进确认按钮——几百条要跑一会儿 */}
      {bulkOpen && (
        <ConfirmDialog
          title="一键入库？"
          description={
            `将把分配给您的 ${publishIds.length} 道待办一次性通过，通过后题目立即入库、全市教师可见。\n` +
            `批量通过不附审批意见；需要写明意见的题目请逐题打开处理。`
          }
          confirmText={
            busy ? `处理中… ${progress?.done ?? 0}/${progress?.total ?? 0}` : "确认入库"
          }
          busy={busy}
          onConfirm={publishAll}
          onClose={() => setBulkOpen(false)}
        />
      )}
    </div>
  )
}

function Row({ r, decided = false, manage = false }) {
  const a = r.approval
  const chipCls =
    a.stage === "group" ? "bg-sky-100 text-sky-700" : "bg-orange-100 text-orange-700"
  const stateChip = approvalStateChip(a.state)
  return (
    <div className="rounded-xl border p-3 sm:p-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${chipCls}`}>{r.stageLabel}环节</span>
          <Badge variant="outline" className="px-1.5 py-0 text-xs">
            {r.kindLabel}
          </Badge>
          {r.qtypeLabel && (
            <Badge variant="secondary" className="px-1.5 py-0 text-xs">
              {r.qtypeLabel}
            </Badge>
          )}
          {r.difficultyLabel && <span className="text-muted-foreground/80">难度 {r.difficultyLabel}</span>}
          {r.versionNo && <span className="text-muted-foreground/70">v{r.versionNo}</span>}
          {decided && (
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${stateChip.cls}`}>
              {stateChip.text}
            </span>
          )}
          {manage && (a.assigned_user_id ? <span>处理人：{r.assignedName}</span> : <span className="text-amber-600">待指派</span>)}
          <span className="text-muted-foreground/70">{fmtDateTime24(a.created_at ?? a.decided_at)}</span>
        </div>
        <p className="line-clamp-2 text-sm text-foreground/90">
          {r.summary || <span className="text-muted-foreground">（无题干内容）</span>}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate">{r.nodePath}</span>
          {r.creatorName && <span>{r.creatorName} 提交</span>}
          {r.schoolName && <span>{r.schoolName}</span>}
          {decided && a.comment && (
            <span className="line-clamp-1 rounded bg-muted/50 px-1.5 py-0.5">
              {a.state === "returned" ? <RotateCcwIcon className="mr-1 inline size-3" /> : null}
              {a.comment}
            </span>
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={`/review/${a.id}`} />}>
            查看详情 <ArrowRightIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
