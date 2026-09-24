import Link from "next/link"
import { accuracyPercent, gradeLabel } from "@/lib/students"
import { fmtDateTime24 } from "@/lib/format"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// 班级学生对照表：一行一个学生，正确率从低到高（要补的排前面）。
//
// 数据直接来自 list_my_students（名册页那个 RPC）——它本来就有每人的
// answered_count / correct_count / graded_count / last_practiced_at，
// 权限门（can_view_student 逐行过滤）也与看板完全一致，**没必要再写一份**。
// 因此这个表的行数可能与"班级人数"不一致：教师看得到的学生才算数（宁可少报）。
export function StudentTable({ rows }) {
  const sorted = [...(rows ?? [])].sort((a, b) => {
    // 没作答的排最后：正确率无从谈起，不该挤在最前面
    const ga = Number(a.graded_count) || 0
    const gb = Number(b.graded_count) || 0
    if (ga === 0 || gb === 0) return gb - ga
    return ga > 0 && gb > 0
      ? (Number(a.correct_count) || 0) / ga - (Number(b.correct_count) || 0) / gb
      : 0
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          学生对照
          <span className="ml-2 font-normal text-muted-foreground">
            {sorted.length} 人 · 按正确率从低到高
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            这个班级还没有可见的学生。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>姓名</TableHead>
                  <TableHead className="text-right">作答</TableHead>
                  <TableHead className="text-right">正确率</TableHead>
                  <TableHead className="hidden sm:table-cell">年级</TableHead>
                  <TableHead>最近练习</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => (
                  <TableRow key={r.user_id}>
                    <TableCell className="font-medium">
                      <Link href={`/students/${r.user_id}`} className="hover:underline">
                        {r.name || "（未填姓名）"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.answered_count ?? 0}
                    </TableCell>
                    {/* 分母是客观题数（graded_count）；没有客观题作答时显示「—」而不是 0% */}
                    <TableCell className="text-right tabular-nums">
                      {accuracyPercent(r) ?? "—"}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {gradeLabel(r.enroll_year) ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {fmtDateTime24(r.last_practiced_at) || "从未"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
