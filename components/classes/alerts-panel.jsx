import Link from "next/link"
import { fmtDateTime24 } from "@/lib/format"
import { percentText } from "@/lib/analytics"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

// 预警：谁掉队了。
//
// 阈值由**服务端随报告一起下发**（alerts.thresholds），文案直接用那几个数字——
// 前端不再写一遍"7 天""15%"，否则改口径时两边会不一致（改了 SQL 忘了改文案，
// 页面就会理直气壮地说错话）。
//
// 正确率下滑带**样本量下限**（近 7 天与前 7 天各至少 10 题）：两次作答错一次就是
// "下降 50%"，不设下限的话这个面板会变成狼来了。
export function AlertsPanel({ report }) {
  const alerts = report.alerts ?? {}
  const thresholds = alerts.thresholds ?? {}
  const inactive = alerts.inactive ?? []
  const drops = alerts.accuracy_drop ?? []

  if (inactive.length === 0 && drops.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">需要关注</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-4 text-center text-sm text-muted-foreground">
            这段时间没有需要特别关注的学生。
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            久未练习（超过 {thresholds.inactive_days ?? 7} 天）
            <span className="ml-2 font-normal text-muted-foreground">{inactive.length} 人</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {inactive.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">都练过。</p>
          ) : (
            inactive.map((s) => (
              <div key={s.user_id} className="flex items-center gap-2 text-sm">
                <Link href={`/students/${s.user_id}`} className="min-w-0 flex-1 truncate hover:underline">
                  {s.name}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {s.days_idle == null ? "从未练习" : `${s.days_idle} 天未练`}
                  {s.last_practiced_at ? ` · 上次 ${fmtDateTime24(s.last_practiced_at)}` : ""}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            正确率下滑（近 7 天 vs 前 7 天，各至少 {thresholds.drop_min_sample ?? 10} 题）
            <span className="ml-2 font-normal text-muted-foreground">{drops.length} 人</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {drops.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">没有明显下滑的。</p>
          ) : (
            drops.map((s) => (
              <div key={s.user_id} className="flex items-center gap-2 text-sm">
                <Link href={`/students/${s.user_id}`} className="min-w-0 flex-1 truncate hover:underline">
                  {s.name}
                </Link>
                <span className="shrink-0 text-xs tabular-nums">
                  <span className="text-muted-foreground">{percentText(s.prev_accuracy)} → </span>
                  <span className="text-rose-600">{percentText(s.recent_accuracy)}</span>
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
