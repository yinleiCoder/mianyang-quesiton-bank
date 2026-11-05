// 动画下方的详细解释：纯展示，无 hook，可由 Server Component 直接渲染。
// 内容在 lib/showcase-scheduler-notes.js，与动画共用同一份常量（改一处两边一起变）。
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { SCHEDULER_NOTES } from "@/lib/showcase-scheduler-notes"

export function SchedulerExplainer() {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {SCHEDULER_NOTES.map((note) => (
        <Card key={note.key}>
          <CardContent className="space-y-3 pt-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-normal">
                {note.eyebrow}
              </Badge>
              <span className="text-base font-medium">{note.title}</span>
            </div>

            <p className="text-muted-foreground leading-relaxed">{note.summary}</p>

            {(note.formulas ?? []).map((formula) => (
              <div key={formula.expr} className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{formula.label}</div>
                <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs whitespace-pre-wrap">
                  {formula.expr}
                </pre>
                {formula.note ? (
                  <p className="text-xs text-muted-foreground">{formula.note}</p>
                ) : null}
              </div>
            ))}

            {(note.params ?? []).length > 0 ? (
              <table className="w-full text-xs">
                <tbody>
                  {note.params.map((param) => (
                    <tr key={param.name} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{param.name}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap text-primary">{param.value}</td>
                      <td className="py-1.5 text-muted-foreground">{param.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {(note.bullets ?? []).length > 0 ? (
              <ul className="space-y-1">
                {note.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-1.5">
                    <span className="text-muted-foreground">·</span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {(note.pitfalls ?? []).length > 0 ? (
              <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50/70 p-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                {note.pitfalls.map((pitfall) => (
                  <li key={pitfall}>· {pitfall}</li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
