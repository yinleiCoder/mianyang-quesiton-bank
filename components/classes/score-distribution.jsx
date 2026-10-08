// 分数段分布条（五档，按得分率）。
//
// 两份数据都画它：班级学情的考试卡片（0087 的 class_exam_results）与 AI 分析页
// （0088 的 summary）。**档位与文案都由服务端下发**，这里只画 ——
// 前端不再写一遍阈值（0079 的 alerts 同规矩：改了 SQL 忘了改文案，页面会理直气壮地说错话）。
//
// rows: [{ key?, label, count }]。key 只用来决定"最低那一档标红"，缺了就按中性色画。
export function ScoreDistribution({ rows = [] }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.count) || 0))
  return (
    <div className="space-y-1">
      {rows.map((r) => {
        const n = Number(r.count) || 0
        return (
          <div key={r.key ?? r.label} className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 text-muted-foreground">{r.label}</span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full rounded-full ${
                  r.key === "lt60" ? "bg-rose-500/80" : "bg-primary/70"
                }`}
                style={{ width: n === 0 ? "0%" : `${Math.max(4, Math.round((n / max) * 100))}%` }}
              />
            </span>
            <span className="w-6 shrink-0 text-right tabular-nums">{n}</span>
          </div>
        )
      })}
    </div>
  )
}
