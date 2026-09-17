// 组卷库列表里的一行。服务端组件（无 "use client"）：纯展示，交互只有链接。
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { fmtDate } from "@/lib/format"
import { round2 } from "@/lib/paper-model"
import { paperStatusChip } from "@/lib/paper-workbench"
import { FileTextIcon, ClockIcon, AlertTriangleIcon } from "lucide-react"

const STAGE_LABEL = { group: "教研组长", city: "市级专家" }

export function PaperCard({ paper, ownerView = false }) {
  const chip = paperStatusChip(paper.status)
  const pending = paper.status === "pending_group" || paper.status === "pending_city"
  return (
    <Link
      href={`/papers/${paper.paper_id}`}
      className="block rounded-xl border p-4 transition-colors hover:border-primary/50 hover:bg-muted/40"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium">{paper.title}</h3>
            <span className={`rounded px-1.5 py-0.5 text-xs ${chip.cls}`}>{chip.text}</span>
            {ownerView && paper.paper_state === "offline" && (
              <Badge variant="secondary" className="font-normal">
                已下线
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {paper.exam_name ? `${paper.exam_name} · ` : ""}
            {paper.subject_label ? `${paper.subject_label} · ` : ""}
            第 {paper.version_no} 版
            {paper.published_at ? ` · 入库于 ${fmtDate(paper.published_at)}` : ""}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1">
              <FileTextIcon className="size-3.5 text-muted-foreground" />
              {paper.item_count} 题
            </span>
            <span className="inline-flex items-center gap-1">
              满分 <b className="tabular-nums">{round2(paper.total_score)}</b> 分
            </span>
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="size-3.5 text-muted-foreground" />
              {paper.duration_minutes} 分钟
            </span>
            {ownerView && paper.health > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertTriangleIcon className="size-3.5" />
                {paper.health} 道题需要处理
              </span>
            )}
          </p>
          {ownerView && pending && (
            <p className="mt-1 text-xs text-muted-foreground">
              当前卡在：{STAGE_LABEL[paper.waiting_stage] ?? "待处理"}
              {(paper.waiting_assignees ?? []).length > 0 ? "" : "（尚未指派处理人，请联系管理员任命）"}
            </p>
          )}
        </div>
      </div>
    </Link>
  )
}
