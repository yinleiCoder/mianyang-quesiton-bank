"use client"

// 教师看学生的六轴学习画像：雷达图 + 画像标签 + 一句总结 + 可折叠的“画像说明”。
//
// 数据是 0128 student_learning_profile 的返回；persona/summary 由 lib/profile-persona.js
// 纯函数拼装（与 Flutter 的 utils/profile_persona.dart 镜像）。
// 隐私：只在校内教师页显示；不提供公开分享/跨班排名；样本不足不画雷达。
import { useMemo } from "react"
import { composeProfile } from "@/lib/profile-persona"
import { LearningProfileChart } from "@/components/students/learning-profile-chart-lazy"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"

function display(value, unit = "") {
  return value == null || Number.isNaN(Number(value)) ? "—" : `${Math.round(Number(value))}${unit}`
}

export function LearningProfileCard({ profile }) {
  const full = useMemo(() => composeProfile(profile), [profile])
  if (!full) return null

  const axes = full.axes ?? []
  const sufficient = axes.filter(
    (axis) => axis.sufficient !== false && axis.score != null
  )
  const missing = axes.filter((axis) => axis.score == null)
  const canDraw = sufficient.length >= 5
  const effort = axes.find((axis) => axis.key === "effort")
  const accuracy = axes.find((axis) => axis.key === "accuracy")
  const mastery = axes.find((axis) => axis.key === "mastery")
  const initial = String(full.student?.name ?? "学").trim().slice(0, 1) || "学"

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
            {initial}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">
              {full.student?.name || "学生"}
              {(full.student?.class_name || full.student?.major_name) && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {[full.student?.class_name, full.student?.major_name]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="font-normal">
                {full.persona?.label ?? "成长中"}
              </Badge>
              <Badge variant="outline" className="font-normal">
                数据窗口 {full.window_days ?? 90} 天
              </Badge>
            </div>
          </div>
          <span className="ml-auto text-xs text-muted-foreground">仅教师可见</span>
        </div>

        {canDraw ? (
          <>
            <LearningProfileChart axes={axes} />
            {missing.length > 0 && (
              <p className="text-xs text-amber-700">
                数据不足：{missing.map((axis) => axis.label).join("、")}（图上按 0 显示）
              </p>
            )}
          </>
        ) : (
          <div className="rounded-lg border bg-muted/20 p-4 text-sm">
            <p className="font-medium">画像还在成长中</p>
            <p className="mt-1 text-xs text-muted-foreground">
              再完成一些练习（每题至少 5 份已判分作答、连续 5 天活跃），就能画出完整六轴。
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {axes.map((axis) => (
                <Badge key={axis.key} variant="outline" className="font-normal">
                  {axis.label} {axis.score ?? "—"}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <Stat label="练习天数（28 天）" value={display(effort?.raw?.active_days_28, " 天")} />
          <Stat label="准确率" value={display(accuracy?.score, "%")} />
          <Stat label="掌握力" value={display(mastery?.score, " 分")} />
        </div>

        <p className="text-sm">{full.summary}</p>

        <details className="rounded-md border bg-muted/20 p-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            画像说明（公式 / 样本 / 不确定之处）
          </summary>
          <ul className="mt-2 space-y-1">
            {axes.map((axis) => (
              <li key={axis.key}>
                <span className="font-medium">{axis.label}</span>：{axis.score ?? "数据不足"}
                {axis.hint ? `；${axis.hint}` : ""}；样本 {axis.sample ?? 0}
              </li>
            ))}
          </ul>
          {full.caveats?.length > 0 && (
            <ul className="mt-1 text-amber-700">
              {full.caveats.map((caveat, index) => (
                <li key={index}>· {caveat}</li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-muted-foreground">
            画像只描述最近的学习状态，不是能力鉴定；不推断人格或心理特征。
          </p>
        </details>
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }) {
  return (
    <div className="rounded-md border px-2 py-1.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  )
}
