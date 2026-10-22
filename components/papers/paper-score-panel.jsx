"use client"

// 右栏下半：选中题目的分值明细。
//
// 「每空的分数」在这里落地：填空题/复合题按计分点逐个列出输入框，改任意一个就把
// 这一题标成"已单独设分"（custom_units）。复合题还提供「按空细分」：把整题分或
// 每个小问的分均摊到各空，总分不变，细分后仍可逐空改。
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Field } from "@/components/papers/paper-field"
import { qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { HEALTH_LABEL } from "@/lib/paper-workbench"
import {
  round2,
  scoreModeLabel,
  effectiveScoreMode,
  unitLabels,
  unitCount,
  refineCompositeUnits,
} from "@/lib/paper-units"
import { RotateCcwIcon, SplitIcon } from "lucide-react"

export function PaperScorePanel({ section, item, sectionIndex, itemIndex, onUnits, onResetUnits, onNote }) {
  const scoreMode = item && section ? effectiveScoreMode(section.score_mode, item.qtype) : null
  const unitLabelList =
    item && section ? unitLabels(section.score_mode, item.qtype, item.content, item.units.length) : []
  const compositeLayoutCount =
    item?.qtype === "composite" ? unitCount("per_sub", "composite", item.content) : 1
  const refinedUnits =
    item?.qtype === "composite" ? refineCompositeUnits(item.units, item.content) : null
  const canRefine = Boolean(refinedUnits && refinedUnits.length > item.units.length)
  const isPerBlank = Boolean(
    item?.qtype === "composite" &&
      item.units.length === compositeLayoutCount &&
      compositeLayoutCount > 1
  )
  const detailLabel = isPerBlank
    ? "逐空"
    : scoreMode === "per_blank"
      ? "按空"
      : scoreMode === "per_sub"
        ? item.qtype === "composite"
          ? "按小问，可细调到每空"
          : "按小问"
        : "整题"

  if (!item) {
    return <p className="text-xs text-muted-foreground">点卷面上的题目查看与调整它的分值</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-medium tabular-nums">第 {item.seq} 题</span>
        <Badge variant="secondary" className="font-normal">
          {qtypeLabel(item.qtype)}
        </Badge>
        <span className="text-xs text-muted-foreground">
          难度 {difficultyLabel(item.difficulty)}
        </span>
      </div>

      {!item.available && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {HEALTH_LABEL.offline}，提交前需先在题库恢复上线，或从卷面移除。
        </p>
      )}
      {item.available && item.stale && (
        <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
          {HEALTH_LABEL.stale}，提交前请点顶栏的「刷新题目」。
        </p>
      )}

      <Field
        label={`分值明细（${detailLabel}）`}
        hint={
          item.custom_units
            ? "已单独设分，不随大题分值变化"
            : scoreMode === "per_sub" && item.qtype === "composite"
              ? `跟随大题「每小问 ${round2(section.score_each)} 分」：各小问总分不变，按空均摊，可逐空调整`
              : `跟随大题「${scoreModeLabel(section.score_mode, item.qtype)} ${round2(section.score_each)} 分」`
        }
      >
        <div className="mt-1 space-y-1.5">
          {item.units.map((u, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs leading-tight text-muted-foreground">
                {unitLabelList[i] ?? `第 ${i + 1} 空`}
              </span>
              <Input
                type="number"
                min="0"
                step="0.5"
                value={u}
                onChange={(e) => {
                  const next = [...item.units]
                  next[i] = e.target.value === "" ? 0 : Number(e.target.value)
                  onUnits(sectionIndex, itemIndex, next)
                }}
                className="h-7"
              />
            </div>
          ))}
        </div>
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          本题合计 <b className="tabular-nums">{round2(item.score)}</b> 分
        </span>
        <div className="flex items-center gap-1">
          {canRefine && (
            <Button
              size="sm"
              variant="secondary"
              title="把当前整题/每个小问的分数均摊到每个空，总分不变；细分后仍可逐空修改"
              onClick={() => onUnits(sectionIndex, itemIndex, refinedUnits)}
            >
              <SplitIcon className="size-3.5" /> 按空细分
            </Button>
          )}
          {item.custom_units && (
            <Button size="sm" variant="ghost" onClick={() => onResetUnits(sectionIndex, itemIndex)}>
              <RotateCcwIcon className="size-3.5" /> 跟随大题
            </Button>
          )}
        </div>
      </div>

      <Field label="备注（只给教师看，不进卷面）">
        <Input
          value={item.note}
          onChange={(e) => onNote(sectionIndex, itemIndex, e.target.value)}
          className="mt-1 h-8"
          placeholder="如：选自 2024 年真题"
        />
      </Field>
    </div>
  )
}
