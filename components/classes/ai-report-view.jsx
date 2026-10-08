import { arr } from "@/lib/ai-report-prompt"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

// 渲染一份 AI 报告（0088 存下来的结构化 json）。
//
// **每一段都可能缺**：模型偶尔会漏字段（提示词要求了，但它不是编译器）。这里一律按"缺了就整段不渲染"
// 处理，而不是渲染出"undefined"或空标题 —— 页面上少一段，教师不会当成系统坏了；
// 多一个空白标题，他会以为分析失败了。
export function AiReportView({ report }) {
  const c = report ?? {}
  const strengths = arr(c.strengths)
  const keyPoints = arr(c.key_points)
  const weak = arr(c.weak_points)
  const notes = arr(c.question_notes)
  const plan = c.plan && typeof c.plan === "object" ? c.plan : {}
  const planRows = [
    { key: "consolidate", label: "知识巩固", items: arr(plan.consolidate) },
    { key: "extend", label: "适度拓展", items: arr(plan.extend) },
    { key: "improve", label: "能力提升", items: arr(plan.improve) },
  ].filter((r) => r.items.length > 0)

  return (
    <div className="space-y-4">
      {c.overview && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">整体表现</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed whitespace-pre-line">{c.overview}</p>
          </CardContent>
        </Card>
      )}

      {strengths.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">做得好的地方</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {strengths.map((s, i) => (
                <li key={i}>{String(s)}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {keyPoints.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">知识点掌握</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {keyPoints.map((k, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                <MasteryChip value={k?.mastery} />
                <span className="font-medium">{k?.point ?? "（未命名知识点）"}</span>
                {k?.evidence && (
                  <span className="text-xs text-muted-foreground">{String(k.evidence)}</span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {weak.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">易错短板</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {weak.map((w, i) => (
              <div key={i} className="space-y-0.5 text-sm">
                <p className="font-medium">{w?.point ?? "（未命名知识点）"}</p>
                {w?.evidence && <p className="text-xs text-muted-foreground">{String(w.evidence)}</p>}
                {w?.suggestion && <p className="text-xs">课堂建议：{String(w.suggestion)}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {notes.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">逐题讲评要点</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {notes.map((n, i) => (
              <p key={i}>
                <b className="tabular-nums">第 {Number(n?.seq) || "?"} 题</b>
                <span className="ml-2">{String(n?.note ?? "")}</span>
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {planRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">下一步复习</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            {planRows.map((r) => (
              <div key={r.key} className="rounded-lg border px-3 py-2">
                <p className="text-xs font-medium text-muted-foreground">{r.label}</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
                  {r.items.map((t, i) => (
                    <li key={i}>{String(t)}</li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {c.caveats && (
        <p className="text-xs text-muted-foreground">数据说明：{String(c.caveats)}</p>
      )}
    </div>
  )
}

// 掌握程度的小标签。模型给的是中文词，认不出来就中性灰 —— 不要猜它想说什么。
function MasteryChip({ value }) {
  const tone =
    value === "较好"
      ? "bg-emerald-100 text-emerald-800"
      : value === "薄弱"
        ? "bg-rose-100 text-rose-800"
        : value === "一般"
          ? "bg-amber-100 text-amber-800"
          : "bg-muted text-muted-foreground"
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${tone}`}>{value ?? "未评级"}</span>
  )
}
