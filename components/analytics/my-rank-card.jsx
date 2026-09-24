import { fmtDuration, percentText, rankTone, viewerNoteText } from "@/lib/analytics"

// 「我的位置」卡：多邻国式的钉住——不管我排第几，先让我看见自己。
//
// 三种状态都要说清：在榜（名次 + 差距）、不在榜（说明原因 + 下一步）、
// 以及连班级都没有的情况。**榜上没有我 ≠ 系统没算**，页面必须解释清楚，
// 否则学生会以为自己的成绩丢了（这也是 viewer_note 存在的唯一理由）。
export function MyRankCard({ board, viewerNote }) {
  const viewer = board?.viewer ?? null
  const stats = board?.stats ?? {}
  const scopeLabel = board?.scope?.label ?? ""

  if (!viewer) {
    const text = viewerNoteText(viewerNote)
    if (!text) return null
    return (
      <div className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
        {text}
      </div>
    )
  }

  const rank = Number(viewer.rank) || 0
  const total = Number(viewer.scope_total) || 0
  const avg = Number(stats.avg_percent)
  const mine = Number(viewer.percent)
  // 与均分的差：按"得分率"比而不是原始分——同卷满分一致时两者等价，但得分率更不容易读错
  const gap = Number.isFinite(avg) && Number.isFinite(mine) ? Math.round((mine - avg) * 1000) / 10 : null
  const chase = viewer.chase

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex size-12 shrink-0 items-center justify-center rounded-full text-lg font-semibold tabular-nums ring-1 ${rankTone(rank)}`}
          >
            {rank}
          </span>
          <div className="text-sm">
            <p className="font-medium">
              我的名次 · {board.scope?.label ?? scopeLabel}
            </p>
            <p className="text-muted-foreground tabular-nums">
              共 {total} 人 · 得分 {Number(viewer.score)}/{Number(viewer.full_score)}
              {viewer.duration_ms ? ` · 用时 ${fmtDuration(viewer.duration_ms)}` : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          {gap != null && (
            <span className={gap >= 0 ? "text-emerald-600" : "text-amber-600"}>
              {gap >= 0 ? "高于" : "低于"}平均分 {Math.abs(gap)} 分
            </span>
          )}
          {chase ? (
            <span className="text-muted-foreground">
              距上一名（{chase.name}）还差{" "}
              <b className="font-medium text-foreground tabular-nums">{Number(chase.gap)}</b> 分
            </span>
          ) : rank === 1 ? (
            <span className="text-amber-600">暂列第一</span>
          ) : null}
          {viewer.school_rank && (
            <span className="text-muted-foreground tabular-nums">
              全校 {viewer.school_rank}/{viewer.school_total}
              {viewer.city_rank ? ` · 全市 ${viewer.city_rank}/${viewer.city_total}` : ""}
            </span>
          )}
        </div>

        {Number.isFinite(mine) && (
          <span className="ml-auto text-sm text-muted-foreground">
            得分率 <b className="text-foreground">{percentText(mine)}</b>
            {Number.isFinite(avg) ? ` · 班均 ${percentText(avg)}` : ""}
          </span>
        )}
      </div>
    </div>
  )
}
