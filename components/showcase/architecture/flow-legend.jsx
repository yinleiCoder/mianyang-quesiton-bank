"use client"

import { SHOWCASE_TONES, toneCss } from "@/lib/showcase-palette"

export function FlowLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
      {Object.entries(SHOWCASE_TONES).map(([key, tone]) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-full"
            style={{ backgroundColor: toneCss(key) }}
          />
          {tone.label}
        </span>
      ))}
      <span className="hidden h-4 w-px bg-border sm:inline-block" />
      <span>实线 = 调用 / 部署</span>
      <span>流动虚线 = 动态链路 / 审批</span>
      <span>静态虚线 = 跳过规则 / 未接入</span>
      <span className="text-muted-foreground/70">滚轮 / 双指缩放 · 拖动画布平移</span>
    </div>
  )
}

export function RoleRules() {
  return (
    <div className="grid gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground md:grid-cols-3">
      <p><span className="font-medium text-foreground">任命：</span>系统管理员任命学校管理员、市级专家；学校管理员任命本校教研组长。</p>
      <p><span className="font-medium text-foreground">审批：</span>教师提交 → 教研组长（stage=group）→ 市级专家（stage=city）→ 入库。</p>
      <p><span className="font-medium text-foreground">边界：</span>系统管理员不能任命教研组长；学校管理员不能任命市级专家；市级专家是岗位池。</p>
    </div>
  )
}
