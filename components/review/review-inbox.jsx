"use client"

// 审批收件箱：我的待办（组长/专家环节统一）→ 处理入口到详情页；管理员多一个"管理"页签（可看全任务/待指派）。
import { useState } from "react"
import Link from "next/link"
import { approvalStateChip } from "@/lib/admin-records"
import { fmtDateTime24 } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/empty-state"
import { ArrowRightIcon, CheckCircle2Icon, CircleSlash2Icon, InboxIcon, RotateCcwIcon } from "lucide-react"

export function ReviewInbox({ mineRows, decidedRows, manageRows, canManage }) {
  const [tab, setTab] = useState("mine")
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

      {current.rows.length === 0 ? (
        <EmptyState {...current.empty} />
      ) : (
        <div className="space-y-2">
          {current.rows.map((r) => (
            <Row key={r.approval.id} r={r} {...current.rowProps} />
          ))}
        </div>
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
