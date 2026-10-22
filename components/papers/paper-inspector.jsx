"use client"

// 右栏属性面板：上半是卷头（整卷属性），下半是当前选中题的分值明细。
// 分值明细单独放在 paper-score-panel.jsx —— 复合题逐空设分的逻辑都在那里，
// 和卷头字段混在一个文件里会让这个面板越来越难读。
import { Input } from "@/components/ui/input"
import { Field } from "@/components/papers/paper-field"
import { PaperScorePanel } from "@/components/papers/paper-score-panel"

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
        <PaperScorePanel
          section={section}
          item={item}
          sectionIndex={sectionIndex}
          itemIndex={itemIndex}
          onUnits={onUnits}
          onResetUnits={onResetUnits}
          onNote={onNote}
        />
      </div>
    </div>
  )
}
