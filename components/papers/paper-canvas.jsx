"use client"

// 卷面画布：按大题分块，每块是一个 SortableContext，整块同时是可放置区
// （空大题也要能接住拖进来的题——否则新建的大题永远填不进去）。
//
// 跨大题拖动只在 onDragEnd 结算，不在 onDragOver 里预移动：预移动看起来更顺滑，
// 但拖到一半松手取消时要把 item 挪回去，容易出现"取消后题跑到别的大题去了"。
// 精确挪动用卡片上的按钮，拖拽只是快捷方式。
import { useMemo } from "react"
import { useDroppable } from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { PaperItemCard } from "@/components/papers/paper-item-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { sectionHeading, round2 } from "@/lib/paper-model"
import { SCORE_MODES } from "@/lib/paper-model"
import { PlusIcon, Trash2Icon, ArrowUpIcon, ArrowDownIcon } from "lucide-react"

function SectionBlock({
  section,
  index,
  sectionCount,
  selected,
  onSelect,
  onSectionUpdate,
  onSectionRemove,
  onSectionMove,
  onItemRemove,
  onItemMove,
  onItemResetUnits,
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `section:${section.key}`,
    data: { type: "section", sectionIndex: index },
  })
  // 稳定引用：SortableContext 每次拿到新数组都会重新测量所有子项
  const itemIds = useMemo(() => section.items.map((it) => `item:${it.key}`), [section.items])

  return (
    <section
      className={`rounded-xl border p-3 transition-colors ${
        isOver ? "border-primary bg-primary/5" : selected?.sectionIndex === index ? "border-primary/60" : "border-border"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <Label className="text-xs text-muted-foreground">大题名称</Label>
          <Input
            value={section.title}
            placeholder={`第${index + 1}大题`}
            onChange={(e) => onSectionUpdate(index, { title: e.target.value })}
            className="mt-1 h-8"
          />
        </div>
        <div className="w-28">
          <Label className="text-xs text-muted-foreground">计分方式</Label>
          <select
            value={section.score_mode}
            onChange={(e) => onSectionUpdate(index, { score_mode: e.target.value })}
            className="mt-1 h-8 w-full rounded-md border bg-transparent px-2 text-sm"
          >
            {SCORE_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="w-24">
          <Label className="text-xs text-muted-foreground">分值</Label>
          <Input
            type="number"
            min="0"
            step="0.5"
            value={section.score_each}
            onChange={(e) => onSectionUpdate(index, { score_each: e.target.value })}
            className="mt-1 h-8"
          />
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            title="上移大题"
            disabled={index === 0}
            onClick={() => onSectionMove(index, index - 1)}
          >
            <ArrowUpIcon className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            title="下移大题"
            disabled={index === sectionCount - 1}
            onClick={() => onSectionMove(index, index + 1)}
          >
            <ArrowDownIcon className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-destructive hover:text-destructive"
            title={section.items.length > 0 ? "大题里还有题目，需先清空" : "删除大题"}
            disabled={section.items.length > 0}
            onClick={() => onSectionRemove(index)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">
        {sectionHeading(
          {
            seq_label: undefined,
            title: section.title || `第${index + 1}大题`,
            score_mode: section.score_mode,
            score_each: Number(section.score_each) || 0,
            item_count: section.items.length,
            section_score: section.items.reduce((a, i) => a + Number(i.score || 0), 0),
            items: section.items,
          },
          index
        )}
      </p>

      <div ref={setNodeRef} className="min-h-14 space-y-2">
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {section.items.map((item, ii) => (
            <PaperItemCard
              key={item.key}
              item={item}
              sectionIndex={index}
              itemIndex={ii}
              sectionCount={sectionCount}
              selected={selected?.sectionIndex === index && selected?.itemIndex === ii}
              onSelect={onSelect}
              onRemove={onItemRemove}
              onMove={onItemMove}
              onResetUnits={onItemResetUnits}
            />
          ))}
        </SortableContext>
        {section.items.length === 0 && (
          <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
            把左边的题目拖到这里，或用「加入本大题」按钮
          </p>
        )}
      </div>
    </section>
  )
}

export function PaperCanvas({
  view,
  selected,
  onSelect,
  onSectionAdd,
  onSectionUpdate,
  onSectionRemove,
  onSectionMove,
  onItemRemove,
  onItemMove,
  onItemResetUnits,
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <span>
          共 <b className="tabular-nums">{view.itemCount}</b> 题
          <span className="mx-2 text-muted-foreground">·</span>
          卷面合计 <b className="tabular-nums">{round2(view.total)}</b> 分
          {view.target != null && (
            <>
              <span className="mx-2 text-muted-foreground">·</span>
              设定总分 <b className="tabular-nums">{view.target}</b> 分
              {view.diffToTarget !== 0 && (
                <span className="ml-1 text-amber-600">
                  （相差 {round2(view.diffToTarget)} 分）
                </span>
              )}
            </>
          )}
        </span>
      </div>

      {view.sections.map((section, index) => (
        <SectionBlock
          key={section.key}
          section={section}
          index={index}
          sectionCount={view.sections.length}
          selected={selected}
          onSelect={onSelect}
          onSectionUpdate={onSectionUpdate}
          onSectionRemove={onSectionRemove}
          onSectionMove={onSectionMove}
          onItemRemove={onItemRemove}
          onItemMove={onItemMove}
          onItemResetUnits={onItemResetUnits}
        />
      ))}

      <Button variant="outline" className="w-full" onClick={onSectionAdd}>
        <PlusIcon className="size-4" /> 添加大题
      </Button>
    </div>
  )
}
