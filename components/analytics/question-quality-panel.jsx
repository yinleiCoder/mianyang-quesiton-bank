// 试题质量诊断面板（服务端组件）：整卷摘要 + 逐题卡片。
// 数据来自 paper_quality_diagnostics；这里只做纯展示，阈值与标记在 lib/ctt.js。
import { summarizeQuality } from "@/lib/ctt"
import { QualityItemCard } from "@/components/analytics/quality-item-card"

export function QuestionQualityPanel({ data }) {
  const summary = data?.summary ?? {}
  const result = summarizeQuality(data?.items ?? [], summary)
  const allBlank =
    result.items.length > 0 &&
    result.items.every((item) => Number(item.n) > 0 && Number(item.blank) >= Number(item.n))

  if (!result.items.length) {
    return (
      <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">
        这份卷子还没有可做质量诊断的作答。
      </p>
    )
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-muted/30 px-4 py-2 text-sm">
        <span className="font-medium">试题质量（CTT）</span>
        <span className="text-muted-foreground">
          平均质量分 <b className="text-foreground tabular-nums">{result.average ?? "—"}</b>
        </span>
        <span className="text-muted-foreground tabular-nums">
          A/B/C/D：{result.counts.A}/{result.counts.B}/{result.counts.C}/{result.counts.D}
        </span>
        <span className="text-muted-foreground">
          需关注 <b className="text-foreground tabular-nums">{result.flagged}</b> 题
        </span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          样本 {summary.attempts ?? 0} 份 · 上下 27% 各 {summary.n_group ?? 0} 人
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        口径：本卷全部官方已出分答卷，不随上方班级/范围切换；样本不足时只给提示，不自动下线题目。
      </p>
      {allBlank && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          这份卷子的作答记录为空（可能来自历史数据迁移/清空），CTT 结果没有诊断意义——请先核对答卷数据是否完整。
        </p>
      )}
      {summary.note && <p className="text-xs text-amber-700">{summary.note}</p>}
      <ul className="space-y-2">
        {result.items.map((item) => (
          <QualityItemCard key={item.paper_item_id} item={item} nGroup={summary.n_group} />
        ))}
      </ul>
    </section>
  )
}
