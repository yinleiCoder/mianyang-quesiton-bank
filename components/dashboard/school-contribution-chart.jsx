"use client"

// 学校贡献图表（管理端）：每校 教师数 / 题目数 分组柱状图。
// 数据由服务端 school_contribution_stats RPC 拉取后透传（纯 props，无客户端请求）。
import * as React from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { cn } from "cn"

const shortName = (n) => (n && n.length > 7 ? `${n.slice(0, 7)}…` : n ?? "")

export function SchoolContributionChart({ data, className }) {
  const rows = React.useMemo(
    () => (data ?? []).map((r) => ({ ...r, teacher_count: Number(r.teacher_count), question_count: Number(r.question_count) })),
    [data]
  )
  if (rows.length === 0) {
    return (
      <p className={cn("rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground", className)}>
        暂无学校数据（学校启用后此处展示各校贡献）
      </p>
    )
  }
  return (
    <div className={cn("h-72 w-full", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0 }} barCategoryGap="26%">
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11 }}
            tickFormatter={shortName}
            interval={0}
            axisLine={false}
            tickLine={false}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={30} axisLine={false} tickLine={false} />
          {/* Tooltip 默认取 Bar 的 name prop（"教师数"/"题目数"），不要用 formatter 按 dataKey 重映射 */}
          <Tooltip cursor={{ fill: "var(--accent)", opacity: 0.4 }} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="teacher_count" name="教师数" fill="#2563eb" maxBarSize={40} radius={[4, 4, 0, 0]} />
          <Bar dataKey="question_count" name="题目数" fill="#059669" maxBarSize={40} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
