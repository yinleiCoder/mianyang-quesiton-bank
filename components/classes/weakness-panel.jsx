import Link from "next/link"
import { rollUpByTopNode } from "@/lib/subject-nodes"
import { accuracyBarColor, percentText } from "@/lib/analytics"
import { qtypeLabel } from "@/lib/question-model"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

// 班级哪里弱：知识点掌握 + 高危题清单。
//
// 知识点在**客户端上卷**到顶层节点（rollUpByTopNode，与个人学情页共用一份），
// 服务端只回课程层原始粒度——上卷是展示口径，写进库里会让两端对不上（0079 的注释）。
//
// 高危题的线是「错误率 ≥ 60%」，与题库页那条 HIGH_ERROR_RATE 同源，且要求至少 5 人作答
// （低于这个样本量，一道题 2 人错 2 人就是"100% 错误率"，排在最前面只会误导）。
export function WeaknessPanel({ report, nodes }) {
  const nodeGroups = rollUpByTopNode(report.node_accuracy ?? [], nodes ?? [])
  const questions = report.high_error_questions ?? []

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">知识点掌握（按顶层科目汇总）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {nodeGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              这段时间里还没有足够的作答可以汇总。
            </p>
          ) : (
            nodeGroups.map((g) => (
              <div key={g.id} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 truncate" title={g.name}>
                  {g.name}
                </span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className={`block h-full rounded-full ${accuracyBarColor(g.accuracy)}`}
                    style={{ width: `${Math.round(g.accuracy * 100)}%` }}
                  />
                </span>
                <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {percentText(g.accuracy)}（{g.correct}/{g.attempts}）
                </span>
              </div>
            ))
          )}
          <p className="pt-1 text-xs text-muted-foreground">
            最弱的排在最前面。只有作答 ≥3 次的科目才会出现在这里。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">最该讲的题（错误率 ≥ 60%，至少 5 人作答）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {questions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              这段时间里没有这样的题——要么都掌握了，要么还没练到。
            </p>
          ) : (
            <ul className="space-y-2">
              {questions.map((q) => (
                <li key={q.question_id} className="flex items-start gap-2 text-sm">
                  {/* 这里给的是**错误率**（标题写的也是它）：教师在这个列表里想的是
                      "这题错得多"，换算成正确率反而要多想一步 */}
                  <span className="mt-0.5 w-14 shrink-0 text-right font-medium text-rose-600 tabular-nums">
                    {percentText(q.error_rate)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="px-1.5 py-0 text-xs">
                        {qtypeLabel(q.qtype)}
                      </Badge>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {q.attempts} 人作答 · 错 {q.attempts - q.correct}
                      </span>
                    </span>
                    {q.available ? (
                      <Link
                        href={`/bank/${q.question_id}`}
                        className="mt-0.5 block truncate text-muted-foreground hover:text-foreground"
                      >
                        {q.stem_text || "（无题干摘要）"}
                      </Link>
                    ) : (
                      <span className="mt-0.5 block truncate text-muted-foreground/60">
                        {q.stem_text || "（题目已下线）"}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
