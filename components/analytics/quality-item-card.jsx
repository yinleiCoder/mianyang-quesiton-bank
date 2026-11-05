// 单题质量卡：折叠摘要（题号/题型/n/p/r/质量分）+ 展开后的题干、标记与干扰项表。
// 用原生 <details>，与 QuestionStatsList 一致：这一页保持服务端组件，不为折叠引入客户端 JS。
import { Badge } from "@/components/ui/badge"
import { DistractorTable } from "@/components/analytics/distractor-table"
import { QualityBadges, QualityMessages } from "@/components/analytics/quality-badges"
import { qtypeShortLabel } from "@/lib/question-model"

const GRADE_STYLES = {
  A: "bg-emerald-100 text-emerald-700",
  B: "bg-sky-100 text-sky-700",
  C: "bg-amber-100 text-amber-700",
  D: "bg-rose-100 text-rose-700",
}

function fmt(value) {
  return value == null ? "—" : Number(value).toFixed(2)
}

export function QualityItemCard({ item, nGroup }) {
  return (
    <li className="rounded-xl border">
      <details className="group">
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm marker:content-none">
          <span className="font-medium tabular-nums">第 {item.seq} 题</span>
          <Badge variant="secondary" className="font-normal">
            {qtypeShortLabel(item.qtype)}
          </Badge>
          <span className="text-xs text-muted-foreground">
            n={item.n}
            {item.blank > 0 ? ` · 未答 ${item.blank}` : ""}
          </span>
          <span className="tabular-nums">p={fmt(item.p_value)}</span>
          <span className="tabular-nums text-muted-foreground">
            r={fmt(item.r_pb)}（{item.r_label}）
          </span>
          <Badge className={`ml-auto font-normal ${GRADE_STYLES[item.grade] ?? ""}`}>
            {item.grade} · {item.quality_score}
          </Badge>
        </summary>

        <div className="space-y-2 border-t px-3 py-3">
          {item.stem_text && (
            <p className="text-sm whitespace-pre-wrap wrap-break-word">{item.stem_text}</p>
          )}
          <QualityBadges flags={item.flags} />
          <QualityMessages flags={item.flags} />
          <DistractorTable options={item.options} nGroup={nGroup} />
        </div>
      </details>
    </li>
  )
}
