// AI 算法说明（只读展示页）：给评委/教师看“每个分数/建议是怎么来的”。
// 内容在 lib/algorithm-notes.js，与代码/迁移同源；改算法时同步改那里。
import { requireUser } from "@/lib/auth"
import { ALGORITHM_NOTES } from "@/lib/algorithm-notes"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"

export const metadata = { title: "AI 算法说明" }

export default async function AlgorithmsPage() {
  await requireUser()

  return (
    <div className="space-y-4">
      <PageHeader
        title="AI 算法说明"
        description="只读展示：LLM 结构化输出、模拟退火组卷、BKT/FSRS/CTT、pg_trgm 查重、Beta 收缩与画像六轴。"
      />

      <div className="grid gap-3 lg:grid-cols-2">
        {ALGORITHM_NOTES.map((note) => (
          <Card key={note.key}>
            <CardContent className="space-y-2 pt-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="font-normal">
                  {note.tag}
                </Badge>
                <span className="font-medium">{note.title}</span>
              </div>

              <p className="text-muted-foreground">{note.summary}</p>

              {note.formula && (
                <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs whitespace-pre-wrap">
                  {note.formula}
                </pre>
              )}

              {note.steps?.length > 0 && (
                <ul className="space-y-1 text-xs">
                  {note.steps.map((step, index) => (
                    <li key={index}>· {step}</li>
                  ))}
                </ul>
              )}

              {note.caveats?.length > 0 && (
                <ul className="rounded-md border border-amber-300 bg-amber-50/70 p-2 text-xs text-amber-900">
                  {note.caveats.map((caveat, index) => (
                    <li key={index}>· {caveat}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
