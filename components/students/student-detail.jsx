// 学生学情详情（服务端组件，无客户端 JS）。
//
// 为什么分科目正确率用 CSS 条形而不是 recharts：recharts 是 300+ KB 的静态导入，
// 本页只是一排横条，用一个 div 的宽度就够了 —— 为它背一个图表库不划算
//（/dashboard 引进 recharts 后首屏 1.4 MB 的教训还写在 docs/加速落地手册.md 里）。
import Link from "next/link"
import { accuracyPercent, gradeLabel } from "@/lib/students"
import { indexNodes, nodePathOf } from "@/lib/subject-nodes"
import { qtypeLabel } from "@/lib/question-model"
import { fmtDate, fmtDateTime24 } from "@/lib/format"
import { avatarUrl } from "@/lib/oss-url"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyState } from "@/components/empty-state"
import { BookOpenCheckIcon, CircleAlertIcon, ClipboardListIcon } from "lucide-react"

// practice_sessions.source 的中文口径（与客户端「记录」页的页签一致）
const SOURCE_LABELS = { all: "全部题目", wrong: "错题重做", favorites: "收藏题目" }
const EXAM_STATUS = {
  submitted: "已交卷",
  grading: "阅卷中",
  graded: "已出分",
}

export function StudentDetail({ detail, nodes }) {
  if (!detail?.student) {
    return <EmptyState icon={CircleAlertIcon} title="学生不存在" description="该账号可能已注销。" />
  }
  const s = detail.student
  const sessions = detail.sessions ?? []
  const wrong = detail.wrong_questions ?? []
  const exams = detail.exams ?? []
  const { byId } = indexNodes(nodes ?? [])

  // 汇总口径与名册页一致：正确率的分母是**客观题**（主观自评题的 is_correct 恒为 null，混进去会压低）
  const answered = sessions.reduce((n, x) => n + (Number(x.answered_count) || 0), 0)
  const durationMs = sessions.reduce((n, x) => n + (Number(x.duration_ms) || 0), 0)
  const nodeGroups = rollUpByTopNode(detail.node_accuracy ?? [], byId)

  return (
    <div className="space-y-4">
      {/* 就读信息：名册的用途是扫读，详情页则要一眼看全 */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-4">
          <Avatar className="size-12 shrink-0 rounded-lg">
            {s.avatar_url && <AvatarImage src={avatarUrl(s.avatar_url)} alt={s.name ?? ""} />}
            <AvatarFallback className="rounded-lg text-base">
              {(s.name || "?").slice(0, 1)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-base font-medium">{s.name || "（未填姓名）"}</span>
              <span className="text-sm text-muted-foreground">{s.email}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
              <Info label="班级" value={s.class_name ?? "未分班"} warn={!s.class_id} />
              <Info label="入学年份" value={gradeLabel(s.enroll_year)} />
              <Info label="专业大类" value={s.major_category} />
              <Info label="专业" value={s.major} />
              {s.created_at && <Info label="注册于" value={fmtDate(s.created_at)} />}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 练习概况 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="练习次数" value={sessions.length} unit="次" />
        <Stat
          label="答题数"
          value={answered}
          unit="题"
          hint={detail.node_accuracy?.length ? undefined : "暂无作答记录"}
        />
        <Stat
          label="客观题正确率"
          value={overallAccuracy(detail.node_accuracy ?? []) ?? "—"}
          hint="主观自评题不计入分母"
        />
        <Stat label="累计用时" value={humanDuration(durationMs)} />
      </div>

      {/* 分科目（按顶层节点归并）正确率 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">分科目掌握情况</CardTitle>
        </CardHeader>
        <CardContent>
          {nodeGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有作答记录。</p>
          ) : (
            <div className="space-y-2.5">
              {nodeGroups.map((g) => (
                <div key={g.id} className="flex items-center gap-3 text-sm">
                  <span className="w-32 shrink-0 truncate text-muted-foreground" title={g.name}>
                    {g.name}
                  </span>
                  <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className={`block h-full rounded-full ${barColor(g.accuracy)}`}
                      style={{ width: `${Math.round(g.accuracy * 100)}%` }}
                    />
                  </span>
                  <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">
                    {Math.round(g.accuracy * 100)}%
                    <span className="ml-1 text-muted-foreground/70">
                      ({g.correct}/{g.attempts})
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 练习历史 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">练习历史</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有完成过练习。</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>开始时间</TableHead>
                    <TableHead>来源</TableHead>
                    <TableHead>范围</TableHead>
                    <TableHead>进度</TableHead>
                    <TableHead>用时</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((x) => (
                    <TableRow key={x.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {fmtDateTime24(x.started_at)}
                      </TableCell>
                      <TableCell>{SOURCE_LABELS[x.source] ?? x.source}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {nodePathOf(nodes ?? [], x.subject_node_id) || "全部"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {x.answered_count}/{x.total_count}
                        {x.correct_count > 0 && (
                          <span className="ml-1.5 text-xs">对 {x.correct_count}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {humanDuration(x.duration_ms) || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="px-1.5 text-xs">
                          {x.status === "active" ? "进行中" : "已完成"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 错题清单 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardListIcon className="size-4" /> 错题（最近一次作答为错）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {wrong.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有错题，或者还没做过题。</p>
          ) : (
            <ul className="divide-y">
              {wrong.map((w) => (
                <li key={w.question_id} className="flex items-start gap-3 py-2.5 text-sm">
                  <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="outline" className="px-1.5 text-xs">
                      {qtypeLabel(w.qtype)}
                    </Badge>
                    <span>错 {w.wrong_count} 次</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    {w.available ? (
                      <Link
                        href={`/bank/${w.question_id}`}
                        className="line-clamp-2 hover:underline"
                      >
                        {w.stem_text || "（题干为空）"}
                      </Link>
                    ) : (
                      // 题目已下线时不展示题干（服务端没回），但还是让学生的情况可见
                      <span className="text-muted-foreground">
                        题目已下线，无法查看题干
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {fmtDate(w.answered_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 考试成绩（只出成绩摘要，不含作答原文 —— 见 0063 里 my_student_detail 上方的论证） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpenCheckIcon className="size-4" /> 组卷考试成绩
          </CardTitle>
        </CardHeader>
        <CardContent>
          {exams.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有交过卷。</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>试卷</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>得分</TableHead>
                    <TableHead>客观 / 主观</TableHead>
                    <TableHead>交卷时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exams.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-medium">{e.paper_title}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="px-1.5 text-xs">
                          {EXAM_STATUS[e.status] ?? e.status}
                        </Badge>
                        {e.pending_review_count > 0 && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            待批 {e.pending_review_count} 题
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {e.total_score == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="font-medium">
                            {num(e.total_score)}
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              / {num(e.full_score)}
                            </span>
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {num(e.objective_score)} / {num(e.subjective_score)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {fmtDateTime24(e.submitted_at) || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Info({ label, value, warn }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 " +
        (warn ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground")
      }
    >
      <span className="opacity-70">{label}</span>
      <span className={warn ? "" : "text-foreground"}>{value || "—"}</span>
    </span>
  )
}

function Stat({ label, value, unit, hint }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold">
        {value}
        {unit && <span className="ml-0.5 text-sm font-normal text-muted-foreground">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground/70">{hint}</div>}
    </div>
  )
}

const num = (v) => (v == null ? "—" : String(Math.round(Number(v) * 100) / 100))

// 全部作答（仅客观题）的正确率；没有客观题作答时返回 null → 调用方显示「—」而不是 0%
function overallAccuracy(nodeAccuracy) {
  const attempts = nodeAccuracy.reduce((n, x) => n + (Number(x.attempts) || 0), 0)
  const correct = nodeAccuracy.reduce((n, x) => n + (Number(x.correct) || 0), 0)
  if (attempts <= 0) return null
  return accuracyPercent({ correct_count: correct, graded_count: attempts })
}

// 把课程级统计上卷到**顶层节点**（专业大类 / 公共学科）。
// 不上卷的话一门课一条，几十个碎条根本读不出"哪块弱"。
function rollUpByTopNode(nodeAccuracy, byId) {
  const grouped = new Map()
  for (const row of nodeAccuracy) {
    const top = topAncestor(byId, row.node_id)
    const cur = grouped.get(top.id) ?? { id: top.id, name: top.name, attempts: 0, correct: 0 }
    cur.attempts += Number(row.attempts) || 0
    cur.correct += Number(row.correct) || 0
    grouped.set(top.id, cur)
  }
  return [...grouped.values()]
    .filter((g) => g.attempts > 0)
    .map((g) => ({ ...g, accuracy: g.correct / g.attempts }))
    .sort((a, b) => a.accuracy - b.accuracy) // 最弱的排最前
}

function topAncestor(byId, nodeId) {
  let cur = byId.get(nodeId)
  if (!cur) return { id: nodeId ?? "unknown", name: "未选节点" }
  // 树最多三层，直接往上走到顶；父节点查不到（数据被删）时就停在当前层
  while (cur.parent_id && byId.get(cur.parent_id)) cur = byId.get(cur.parent_id)
  return cur
}

function barColor(accuracy) {
  if (accuracy < 0.5) return "bg-rose-500/80"
  if (accuracy < 0.75) return "bg-amber-500/80"
  return "bg-emerald-500/80"
}

// 毫秒 → 人话。练习动辄几十秒，所以不足 1 分钟显示秒。
function humanDuration(ms) {
  const n = Number(ms) || 0
  if (n <= 0) return ""
  const totalMin = Math.round(n / 60000)
  if (totalMin < 1) return `${Math.round(n / 1000)} 秒`
  if (totalMin < 60) return `${totalMin} 分钟`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}
