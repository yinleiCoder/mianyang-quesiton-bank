"use client"

// 右栏属性面板：上半是卷头（整卷属性），下半是当前选中题的分值明细。
//
// 「每空的分数」在这里落地：选中的题若是填空题/复合题，按给分点逐个列出输入框，
// 改任意一个就把这一题标成"已单独设分"（custom_units），不再跟随大题口径。
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { round2, scoreModeLabel, effectiveScoreMode } from "@/lib/paper-model"
import { qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { HEALTH_LABEL } from "@/lib/paper-workbench"
import { RotateCcwIcon } from "lucide-react"

function Field({ label, hint, children }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function PaperInspector({ meta, onMeta, selected, onUnits, onResetUnits, onNote }) {
  const { section, item, sectionIndex, itemIndex } = selected ?? {}

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <h3 className="text-sm font-medium">卷头</h3>
        <Field label="试卷标题" hint="打印时居中放大显示，必填">
          <Input
            value={meta.title}
            onChange={(e) => onMeta({ title: e.target.value })}
            className="mt-1 h-8"
            placeholder="如：计算机类模拟卷"
          />
        </Field>
        <Field label="考试名称" hint="卷面最上面一行，如「四川省2024年高职教育单招」">
          <Input
            value={meta.exam_name}
            onChange={(e) => onMeta({ exam_name: e.target.value })}
            className="mt-1 h-8"
          />
        </Field>
        <Field label="科目">
          <Input
            value={meta.subject_label}
            onChange={(e) => onMeta({ subject_label: e.target.value })}
            className="mt-1 h-8"
            placeholder="如：计算机类试题"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="考试时长（分钟）">
            <Input
              type="number"
              min="1"
              max="600"
              value={meta.duration_minutes}
              onChange={(e) => onMeta({ duration_minutes: e.target.value })}
              className="mt-1 h-8"
            />
          </Field>
          <Field label="设定总分">
            <Input
              type="number"
              min="0"
              step="0.5"
              value={meta.target_score ?? ""}
              placeholder="留空不校验"
              onChange={(e) => onMeta({ target_score: e.target.value === "" ? null : e.target.value })}
              className="mt-1 h-8"
            />
          </Field>
        </div>
        <Field label="卷头信息栏" hint="姓名/学号/得分填写栏，正式考试卷保留">
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={meta.header?.show_candidate_bar !== false}
              onChange={(e) =>
                onMeta({ header: { ...(meta.header ?? {}), show_candidate_bar: e.target.checked } })
              }
            />
            打印姓名 / 学号 / 得分栏
          </label>
        </Field>
      </div>

      <div className="border-t pt-4">
        <h3 className="mb-2 text-sm font-medium">选中题目</h3>
        {!item ? (
          <p className="text-xs text-muted-foreground">点卷面上的题目查看与调整它的分值</p>
        ) : (
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
              label={`分值明细（${effectiveScoreMode(section.score_mode, item.qtype) === "per_blank" ? "按空" : effectiveScoreMode(section.score_mode, item.qtype) === "per_sub" ? "按小问" : "整题"}）`}
              hint={
                item.custom_units
                  ? "已单独设分，不随大题分值变化"
                  : `跟随大题「${scoreModeLabel(section.score_mode, item.qtype)} ${round2(section.score_each)} 分」`
              }
            >
              <div className="mt-1 space-y-1.5">
                {item.units.map((u, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">
                      {item.units.length > 1 ? `第 ${i + 1} 空` : "本题"}
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

            <div className="flex items-center justify-between">
              <span className="text-sm">
                本题合计 <b className="tabular-nums">{round2(item.score)}</b> 分
              </span>
              {item.custom_units && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onResetUnits(sectionIndex, itemIndex)}
                >
                  <RotateCcwIcon className="size-3.5" /> 跟随大题
                </Button>
              )}
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
        )}
      </div>
    </div>
  )
}
