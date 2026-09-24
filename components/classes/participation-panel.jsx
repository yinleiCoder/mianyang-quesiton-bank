import { fmtDateTime24 } from "@/lib/format"
import { percentText } from "@/lib/analytics"
import { Card, CardContent } from "@/components/ui/card"

// 参与度 + 逐日趋势。
//
// 趋势用纯 CSS 柱：一天一根，高度按当日作答数归一（不是按"人数"——一个学霸刷 200 题
// 和 20 个人各刷 10 题，对教师是两件不同的事，这里要的是"这个班动起来了没有"）。
// 不引 recharts：这一页其余部分也是纯 CSS，为一条柱状图背 300KB 不值当
// （students/student-detail.jsx 的头注已经把这条教训写死了）。
export function ParticipationPanel({ report }) {
  const p = report.participation ?? {}
  const trend = report.trend ?? []
  const maxAnswered = Math.max(1, ...trend.map((t) => Number(t.answered) || 0))
  const activeRate = p.student_count > 0 ? p.active_count / p.student_count : null

  const tiles = [
    { label: "班级人数", value: p.student_count ?? 0 },
    {
      label: `活跃（${report.window?.days ?? 30} 天）`,
      value: `${p.active_count ?? 0} 人`,
      hint: activeRate == null ? null : percentText(activeRate),
    },
    { label: "作答（客观题）", value: p.answered_count ?? 0 },
    {
      label: "班级正确率",
      // 分母是已判分的客观题（与名册页同口径）；没有人作答时是 null，不是 0%
      value: p.answered_count > 0 ? percentText(p.correct_count / p.answered_count) : "—",
      hint: p.answered_count > 0 ? `答对 ${p.correct_count} 次` : "暂无作答",
    },
  ]

  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg border px-3 py-2">
              <p className="text-xs text-muted-foreground">{t.label}</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{t.value}</p>
              {t.hint && <p className="text-xs text-muted-foreground">{t.hint}</p>}
            </div>
          ))}
        </div>

        <div>
          <div className="mb-1 flex items-baseline justify-between text-xs text-muted-foreground">
            <span>每日作答量</span>
            <span>
              {report.window?.from} ~ {report.window?.to} · 最近练习{" "}
              {fmtDateTime24(p.last_active_at) || "暂无"}
            </span>
          </div>
          {/* 柱状：没作答的日子也画一根空槽，否则"中间断了三天"看不出来 */}
          <div className="flex h-24 items-end gap-px overflow-hidden rounded-md border bg-muted/20 p-1">
            {trend.map((t) => {
              const n = Number(t.answered) || 0
              const h = n === 0 ? 2 : Math.max(6, Math.round((n / maxAnswered) * 100))
              return (
                <div
                  key={t.date}
                  className={`flex-1 rounded-sm ${n === 0 ? "bg-muted" : "bg-primary/70"}`}
                  style={{ height: `${h}%` }}
                  title={`${t.date}：${n} 题 · ${t.active_students} 人 · 正确率 ${
                    t.accuracy == null ? "—" : percentText(t.accuracy)
                  }`}
                />
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
