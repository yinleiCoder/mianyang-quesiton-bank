"use client"

// 学生自己的遗忘曲线 vs 艾宾浩斯理论线（recharts）。
//
// 用户 2026-10-24 明确要求改用 recharts。它与站内其他图表（学校贡献）同一套组件，
// 悬浮提示、坐标轴、响应式都由库处理，不必再手画 SVG。
//
// 口径与学生端 App 的 ForgettingCurveChart 一致：
//   · 横轴是「距上次练同一道题的天数」，按真实天数摆，不是等距分桶；
//   · 纵轴从 0 起（理论线会掉到 21%，只画实测那一段会显得"掉得很厉害"）；
//   · 每桶至少 3 次作答才算可信点，少于 2 个可信点就不画线、只说明原因。
//
// 两条线的采样点不同：理论线是 0~30 天每 0.25 天一个点，实测只有服务器分桶的
// 那几个整数天。合成一条 data 数组后，实测线用 connectNulls 跨过理论采样点，
// 否则 recharts 会把实测线切成一段一段的。

import { useMemo } from "react"
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  ebbinghausSamples,
  plottableBuckets,
  RELIABLE_BUCKET_ATTEMPTS,
} from "@/lib/forgetting-curve"

export function ForgettingCurveChart({ buckets = [] }) {
  const points = useMemo(() => plottableBuckets(buckets), [buckets])
  const practiced = buckets.reduce((n, b) => n + (Number(b.attempts) || 0), 0)

  const data = useMemo(() => {
    const byDay = new Map(points.map((p) => [p.days, p]))
    const theory = ebbinghausSamples({ maxDays: 30, count: 120 })
    const rows = theory.map(([day, retention]) => ({
      day,
      theory: retention,
      measured: byDay.get(day)?.accuracy ?? null,
      attempts: byDay.get(day)?.attempts ?? null,
      correct: byDay.get(day)?.correct ?? null,
    }))
    // 服务器分桶的点若不在理论采样点上（正常不会），也要补进来
    for (const p of points) {
      if (!rows.some((r) => r.day === p.days)) {
        rows.push({
          day: p.days,
          theory: null,
          measured: p.accuracy,
          attempts: p.attempts,
          correct: p.correct,
        })
      }
    }
    return rows.sort((a, b) => a.day - b.day)
  }, [points])

  if (points.length < 2) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">
          {practiced === 0 ? "还没有可画的遗忘曲线" : "样本还不够画出曲线"}
        </p>
        <p className="mt-1">
          {practiced === 0
            ? "同一道题隔几天再练一次，就能看出这位学生忘得有多快。"
            : `已经有 ${practiced} 次「隔一段时间又练」的作答；每个间隔档至少 ${RELIABLE_BUCKET_ATTEMPTS} 次、且攒够两档才画线。`}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded bg-primary" />
          实测保持率
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded bg-muted-foreground/60" />
          艾宾浩斯理论线
        </span>
        <span>可信点：每档 ≥{RELIABLE_BUCKET_ATTEMPTS} 次作答</span>
      </div>

      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="day"
              type="number"
              domain={[0, 30]}
              ticks={[0, 7, 14, 21, 30]}
              tickFormatter={(v) => `${v} 天`}
              tick={{ fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v) => `${Math.round(v * 100)}%`}
              tick={{ fontSize: 11 }}
              width={38}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CurveTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="theory"
              name="艾宾浩斯理论线"
              stroke="var(--muted-foreground)"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="measured"
              name="实测保持率"
              stroke="var(--primary)"
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              // 实测点之间隔着理论线的采样点（null），必须连起来
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-xs text-muted-foreground">
        理论线是艾宾浩斯用无意义音节测出的基线（1 天后只剩 33%）。学生练的是有内容的题目，
        实测线在上方是正常的；真正要看的是它掉得快不快——某一档掉得特别狠，就是那一档的复习间隔该缩短。
      </p>
    </div>
  )
}

function CurveTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const measured = payload.find((p) => p.dataKey === "measured")
  const theory = payload.find((p) => p.dataKey === "theory")
  const row = measured?.payload ?? theory?.payload ?? {}

  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium">隔 {Number(label)} 天</p>
      {measured?.value != null && (
        <p className="text-primary">
          实测 {Math.round(Number(measured.value) * 100)}%
          {row.correct != null && row.attempts != null ? `（${row.correct}/${row.attempts} 次答对）` : ""}
        </p>
      )}
      {theory?.value != null && (
        <p className="text-muted-foreground">理论 {Math.round(Number(theory.value) * 100)}%</p>
      )}
    </div>
  )
}
