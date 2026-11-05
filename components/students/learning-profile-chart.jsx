"use client"

// 学习画像雷达图（recharts）。**只由 lazy 外壳动态引入**，避免把 366KB 的
// recharts 静态打进 /students/[id] 的首屏包（与 dashboard 的学校贡献图同一取舍）。
import { useMemo } from "react"
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts"

export function LearningProfileChart({ axes = [], name = "本人" }) {
  const data = useMemo(
    () =>
      axes.map((axis) => ({
        axis: axis.label,
        score: axis.score == null ? 0 : Number(axis.score),
        sufficient: axis.sufficient !== false && axis.score != null,
      })),
    [axes]
  )

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="70%">
          <PolarGrid stroke="var(--border)" />
          <PolarAngleAxis
            dataKey="axis"
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
          />
          <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
          <Tooltip
            formatter={(value) => [`${value} / 100`, "得分"]}
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              color: "var(--popover-foreground)",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Radar
            name={name}
            dataKey="score"
            stroke="var(--primary)"
            fill="var(--primary)"
            fillOpacity={0.25}
            strokeWidth={2}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  )
}
