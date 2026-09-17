"use client"

// 卷面上的一个题项：可拖拽排序，也可用按钮精确挪动。
//
// 为什么拖拽之外还必须有按钮：一份真题动辄 32 道选择题，用鼠标精确拖到第 17 题和第 18 题之间
// 是不现实的；键盘用户更是完全用不了拖拽。dnd-kit 的 KeyboardSensor 能覆盖一部分，
// 但"移到上一大题"这种跨容器操作还是按钮最直接。
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { qtypeShortLabel, difficultyLabel } from "@/lib/question-model"
import { round2 } from "@/lib/paper-model"
import { HEALTH_LABEL } from "@/lib/paper-workbench"
import {
  GripVerticalIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  CornerLeftUpIcon,
  Trash2Icon,
  RotateCcwIcon,
} from "lucide-react"

export function PaperItemCard({
  item,
  sectionIndex,
  itemIndex,
  sectionCount,
  onRemove,
  onMove,
  onResetUnits,
  onSelect,
  selected,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `item:${item.key}`,
    data: { type: "item", sectionIndex, itemIndex },
  })

  const style = { transform: CSS.Transform.toString(transform), transition }
  const health = item.available === false ? "offline" : item.stale ? "stale" : null

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border bg-card p-2.5 text-sm transition-shadow ${
        isDragging ? "opacity-40" : ""
      } ${selected ? "border-primary ring-1 ring-primary/30" : "border-border/70"}`}
      onClick={() => onSelect?.(sectionIndex, itemIndex)}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="mt-0.5 cursor-grab touch-none text-muted-foreground hover:text-foreground"
          aria-label="拖动排序"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-4" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium tabular-nums">{item.seq}.</span>
            <Badge variant="secondary" className="font-normal">
              {qtypeShortLabel(item.qtype)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              难度 {difficultyLabel(item.difficulty)}
            </span>
            <span className="text-xs font-medium">{round2(item.score)} 分</span>
            {item.units?.length > 1 && (
              <span className="text-xs text-muted-foreground">（{item.units.length} 个给分点）</span>
            )}
            {item.custom_units && (
              <Badge variant="outline" className="font-normal" title="这一题的分值已单独设定">
                已单独设分
              </Badge>
            )}
            {item.origin === "import" && (
              <Badge variant="outline" className="font-normal">
                AI 还原
              </Badge>
            )}
            {health && (
              <Badge variant="destructive" className="font-normal">
                {HEALTH_LABEL[health]}
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.summary || "（无题干预览）"}</p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {item.custom_units && onResetUnits && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="改回跟随大题分值"
              onClick={(e) => {
                e.stopPropagation()
                onResetUnits(sectionIndex, itemIndex)
              }}
            >
              <RotateCcwIcon className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="上移"
            disabled={sectionIndex === 0 && itemIndex === 0}
            onClick={(e) => {
              e.stopPropagation()
              onMove("up", sectionIndex, itemIndex)
            }}
          >
            <ArrowUpIcon className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="下移"
            disabled={sectionIndex === sectionCount - 1 && itemIndex === Number.MAX_SAFE_INTEGER}
            onClick={(e) => {
              e.stopPropagation()
              onMove("down", sectionIndex, itemIndex)
            }}
          >
            <ArrowDownIcon className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="移到上一大题末尾"
            disabled={sectionIndex === 0}
            onClick={(e) => {
              e.stopPropagation()
              onMove("prevSection", sectionIndex, itemIndex)
            }}
          >
            <CornerLeftUpIcon className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-destructive hover:text-destructive"
            title="从卷面移除"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(sectionIndex, itemIndex)
            }}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
