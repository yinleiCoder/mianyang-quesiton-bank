"use client"

// 学情问数的结果展示：弱项/趋势用 CSS 图，试卷口径用表格。
// 纯展示，不做查询；数据由 ask-data.jsx 调只读 RPC 后传入。
import { Badge } from "@/components/ui/badge"
import { qtypeShortLabel } from "@/lib/question-model"

function pct(value) {
  if (value == null || Number.isNaN(Number(value))) return "—"
  return `${Math.round(Number(value) * 100)}%`
}

export function AskDataResult({ result }) {
  if (!result) return null
  if (result.clarify) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50/70 p-3 text-sm text-amber-900">
        {result.clarify}
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{result.title}</span>
        {result.params?.days != null && (
          <Badge variant="secondary" className="font-normal">
            最近 {result.params.days} 天
          </Badge>
        )}
        {result.params?.scope && (
          <Badge variant="secondary" className="font-normal">
            范围：{result.params.scope}
          </Badge>
        )}
      </div>

      <p className="text-sm">{result.summary}</p>

      {result.intent === "weak_nodes" && <WeakBars rows={result.rows} />}
      {result.intent === "practice_trend" && <TrendBars rows={result.rows} />}
      {result.intent === "question_stats" && <StatsTable rows={result.rows} />}
      {result.intent === "question_quality" && <QualityTable rows={result.rows} />}
      {result.intent === "leaderboard" && <LeaderboardTable rows={result.rows} />}
      {result.intent === "student_detail" && (
        <StudentDetailTables rows={result.rows} wrong={result.wrong} />
      )}

      {result.note && <p className="text-xs text-muted-foreground">{result.note}</p>}
      <p className="text-xs text-muted-foreground">
        数据来自只读 RPC；问题只解析成查询意图，不生成 SQL、不改任何数据。
      </p>
    </div>
  )
}

function WeakBars({ rows = [] }) {
  if (!rows.length) return null
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.node_id}>
          <div className="flex items-center justify-between text-xs">
            <span className="truncate">{row.name}</span>
            <span className="shrink-0 text-muted-foreground">
              {pct(row.accuracy)} · {row.attempts} 次
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.max(2, Math.round((row.accuracy ?? 0) * 100))}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function TrendBars({ rows = [] }) {
  if (!rows.length) return null
  const recent = rows.slice(-14)
  const max = Math.max(...rows.map((row) => row.answered), 1)
  return (
    <div className="space-y-1">
      <div className="flex h-28 items-end gap-1">
        {recent.map((row) => (
          <div
            key={row.date}
            className="flex-1 rounded-t-sm bg-primary/70"
            style={{ height: `${Math.max(4, Math.round((row.answered / max) * 100))}%` }}
            title={`${row.date}：${row.answered} 题，正确率 ${pct(row.accuracy)}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{recent[0]?.date}</span>
        <span>{recent[recent.length - 1]?.date}</span>
      </div>
    </div>
  )
}

function StatsTable({ rows = [] }) {
  if (!rows.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b text-left">
            <th className="py-1 pr-2 font-normal">题号</th>
            <th className="py-1 pr-2 font-normal">题型</th>
            <th className="py-1 pr-2 font-normal">已判分</th>
            <th className="py-1 pr-2 font-normal">正确率</th>
            <th className="py-1 font-normal">最常误选</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.seq} className="border-b last:border-0">
              <td className="py-1 pr-2">{row.seq}</td>
              <td className="py-1 pr-2">{qtypeShortLabel(row.qtype)}</td>
              <td className="py-1 pr-2">{row.graded}</td>
              <td className="py-1 pr-2">{pct(row.correct_rate)}</td>
              <td className="py-1">{row.top_wrong || row.top_texts?.join(" / ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function QualityTable({ rows = [] }) {
  if (!rows.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b text-left">
            <th className="py-1 pr-2 font-normal">题号</th>
            <th className="py-1 pr-2 font-normal">题型</th>
            <th className="py-1 pr-2 font-normal">样本</th>
            <th className="py-1 pr-2 font-normal">难度 p</th>
            <th className="py-1 pr-2 font-normal">区分度 r</th>
            <th className="py-1 font-normal">提示</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.seq} className="border-b last:border-0">
              <td className="py-1 pr-2">{row.seq}</td>
              <td className="py-1 pr-2">{qtypeShortLabel(row.qtype)}</td>
              <td className="py-1 pr-2">{row.n}</td>
              <td className="py-1 pr-2">{row.p_value == null ? "—" : Number(row.p_value).toFixed(2)}</td>
              <td className="py-1 pr-2">{Number(row.r_pb).toFixed(2)}</td>
              <td className="py-1">{row.note || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StudentDetailTables({ rows = [], wrong = [] }) {
  return (
    <div className="space-y-4">
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b text-left">
                <th className="py-1 pr-2 font-normal">知识点</th>
                <th className="py-1 pr-2 font-normal">作答</th>
                <th className="py-1 font-normal">正确率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.node_id} className="border-b last:border-0">
                  <td className="py-1 pr-2">{row.name}</td>
                  <td className="py-1 pr-2">{row.attempts}</td>
                  <td className="py-1">{pct(row.accuracy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {wrong.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">错得最多的题</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-1 pr-2 font-normal">题干</th>
                  <th className="py-1 pr-2 font-normal">题型</th>
                  <th className="py-1 font-normal">错误次数</th>
                </tr>
              </thead>
              <tbody>
                {wrong.map((row) => (
                  <tr
                    key={`${row.question_id}-${row.stem}`}
                    className="border-b last:border-0"
                  >
                    <td className="py-1 pr-2">{row.stem}</td>
                    <td className="py-1 pr-2">{qtypeShortLabel(row.qtype)}</td>
                    <td className="py-1">{row.wrong_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function LeaderboardTable({ rows = [] }) {
  if (!rows.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b text-left">
            <th className="py-1 pr-2 font-normal">名次</th>
            <th className="py-1 pr-2 font-normal">姓名</th>
            <th className="py-1 pr-2 font-normal">分数</th>
            <th className="py-1 font-normal">百分比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.rank}-${row.name}`} className="border-b last:border-0">
              <td className="py-1 pr-2">{row.rank}</td>
              <td className="py-1 pr-2">{row.name}</td>
              <td className="py-1 pr-2">
                {row.score ?? "—"}/{row.full_score ?? "—"}
              </td>
              <td className="py-1">{pct(row.percent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
