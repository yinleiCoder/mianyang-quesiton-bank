"use client"

// 审批收件箱：我的待办（组长/专家环节统一）→ 处理入口到详情页；管理员多一个"管理"页签（可看全任务/待指派）。
// 待办上另有两种批量通过（详见 lib/bulk-rpc.js 的逐条策略）：
//   市级专家「一键入库」（city 环节，通过即入库）与教研组长「一键流转」（group 环节，通过仅转给专家）。
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

// 批量通过的两个口径。语义不同（入库 vs 只是流转），所以是两个按钮、两次确认，绝不合并：
// 组长环节按错一下就把全市可见的内容发出去了，这个误操作代价必须由确认文案挡住。
const BULK_KINDS = {
  publish: {
    label: "一键入库",
    verb: "入库",
    hint: "把待办里市级专家环节的题目一次性通过：通过即入库、全市可见（等同逐题点「通过」）",
    title: "一键入库？",
    description: (n) =>
      `将把分配给您的 ${n} 道待办一次性通过，通过后题目立即入库、全市教师可见。\n` +
      `批量通过不附审批意见；需要写明意见的题目请逐题打开处理。`,
    confirmText: "确认入库",
  },
  flow: {
    label: "一键流转",
    verb: "流转",
    hint: "把待办里教研组长环节的题目一次性通过：通过后流转至市级专家，此时尚未入库、全市不可见",
    title: "一键流转至市级专家？",
    description: (n) =>
      `将把分配给您的 ${n} 道待办一次性通过，通过后题目流转到市级专家环节等待入库，此时尚未对全市可见。\n` +
      `批量通过不附审批意见；需要写明意见的题目请逐题打开处理。`,
    confirmText: "确认流转",
  },
}

export function ReviewInbox({
  mineRows,
  decidedRows,
  manageRows,
  canManage,
  publishableIds = [],
  flowableIds = [],
}) {
  const router = useRouter()
  const [tab, setTab] = useState("mine")
  // 已批量处理掉的任务 id：以服务端为准（router.refresh() 后 prop 会换新），本页批量通过的
  // 记进 processed 摘掉——这样「别处已处理」的失败项也不会在按钮计数里阴魂不散。
  // 两种批量共用一个数组：一道题同时只处在一个环节，两边不会有交集
  const [processed, setProcessed] = useState([])
  const [bulk, setBulk] = useState(null) // 待确认的批量动作 {kind, ids}；ids 在点开确认框时定格
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null) // {done, total}

  const pendingOf = (kind) =>
    (kind === "publish" ? publishableIds : flowableIds).filter((id) => !processed.includes(id))

  async function runBulk() {
    const { kind, ids } = bulk
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
      const text = bulkResultMessage(BULK_KINDS[kind].verb, ok, failed)
      if (failed.length > 0) toast.warning(text)
      else toast.success(text)
      router.refresh() // 待办/已处理两个页签的数据都来自服务端
    } catch (err) {
      toast.error(err?.message ?? "批量处理失败")
    } finally {
      setBusy(false)
      setProgress(null)
      setBulk(null)
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
        {/* 批量通过：只在「我的待办」页签、且确有对应任务时出现（见 lib/review-workbench.js）。
            教研组长看得到「一键流转」，市级专家看得到「一键入库」，两者都有则两个按钮并排 */}
        {tab === "mine" && (
          <div className="flex flex-wrap gap-1.5">
            {["flow", "publish"].map((kind) => {
              const ids = pendingOf(kind)
              if (ids.length === 0) return null
              const cfg = BULK_KINDS[kind]
              return (
                <Button
                  key={kind}
                  size="sm"
                  variant="outline"
                  title={cfg.hint}
                  onClick={() => setBulk({ kind, ids })}
                  disabled={busy}
                >
                  <CheckCircle2Icon className="size-3.5" /> {cfg.label}（{ids.length}）
                </Button>
              )
            })}
          </div>
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
      {bulk && (
        <ConfirmDialog
          title={BULK_KINDS[bulk.kind].title}
          description={BULK_KINDS[bulk.kind].description(bulk.ids.length)}
          confirmText={
            busy
              ? `处理中… ${progress?.done ?? 0}/${progress?.total ?? 0}`
              : BULK_KINDS[bulk.kind].confirmText
          }
          busy={busy}
          onConfirm={runBulk}
          onClose={() => setBulk(null)}
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
          {manage &&
            (r.assignedNames.length > 0 ? (
              <span>处理人：{r.assignedNames.join("、")}</span>
            ) : (
              <span className="text-amber-600">待指派</span>
            ))}
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
