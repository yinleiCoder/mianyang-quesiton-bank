import Link from "next/link"
import { fmtDateTime24 } from "@/lib/format"
import { percentText } from "@/lib/analytics"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScoreDistribution } from "@/components/classes/score-distribution"
import { Reveal } from "@/components/ui/reveal"

// 考试结果：这个班考过的每份卷——谁最高、谁最低、谁进步最大、分数怎么分布（0087）。
//
// 与同一页其它面板的分工：那边是**练习**（0079 的参与度/知识点/预警），这边是**考试**。
// 三条口径必须写在明面上，因为它们决定了数字怎么读：
//   · 只算**第一次交卷**（同一份卷面重做是自主练习，0076 的 is_official）；
//   · 只算**当前入库版本**（改版后满分与题都变了，混排不公平）；
//   · **没有"布置考试"**——学生是自己从试卷库挑卷考的，所以"参加 5/27 人"是常态而不是异常。
//
// 「进步最大」= 同一学生在这份卷与**上一份卷**上的得分率之差（中间那场缺考的不参与），
// 所以两个百分数并列展示：读作"上次 0% → 这次 70%"。**不能写成"+70 分"**——
// 两份卷满分不同，只有得分率能横向比。
export function ExamResultsPanel({ results, classId }) {
  const papers = results?.papers ?? []
  const days = results?.window?.days ?? 30
  const studentCount = results?.student_count ?? 0

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">考试结果（近 {days} 天）</h2>
        <span className="text-xs text-muted-foreground">
          只算第一次交卷 · 只算当前入库版本 · 学生自助考卷，不是教师布置
        </span>
      </div>

      {papers.length === 0 ? (
        <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
          近 {days} 天这个班还没有考试成绩。学生在客户端自助考卷，交卷并出分后就会按卷出现在这里
          ——每份卷都会带上「看成绩榜 / 讲评 / AI 分析」的入口。
        </p>
      ) : (
        <Reveal className="space-y-3" stagger={0.06}>
          {papers.map((p) => (
            <PaperCard key={p.paper_id} paper={p} classId={classId} studentCount={studentCount} />
          ))}
        </Reveal>
      )}

      {results?.truncated && (
        <p className="text-xs text-muted-foreground">
          只列出最近 {results.max_papers} 场，更早的卷子没有显示。
        </p>
      )}
    </section>
  )
}

function PaperCard({ paper, classId, studentCount }) {
  const stats = paper.stats ?? {}
  const improved = paper.most_improved

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-sm">
            {paper.title || "（无标题）"}
            {paper.exam_name && (
              <span className="ml-2 font-normal text-muted-foreground">{paper.exam_name}</span>
            )}
          </CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {fmtDateTime24(paper.last_submitted_at)} · 满分 {Number(paper.full_score)}
            {paper.subject_label ? ` · ${paper.subject_label}` : ""}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          参加{" "}
          <b className="text-foreground tabular-nums">{Number(paper.participants) || 0}</b>
          <span className="tabular-nums">/{studentCount}</span> 人
          {/* 班均是 null 而不是 0：一份卷全部待阅卷时"班均 0 分"是句错话（与 lib/accuracy.js 同规矩） */}
          {stats.avg_score != null && (
            <span className="tabular-nums"> · 班均 {Number(stats.avg_score)} 分</span>
          )}
          {Number(paper.ungraded) > 0 && (
            <span className="text-amber-600"> · 另有 {paper.ungraded} 人待阅卷，出分后才计入</span>
          )}
        </p>

        <div className="grid gap-2 sm:grid-cols-3">
          <Person
            label="最高分"
            person={paper.top}
            detail={`${Number(paper.top?.score)}/${Number(paper.full_score)}`}
            note={percentText(paper.top?.percent)}
            empty="还没有出分的成绩"
          />
          <Person
            label="最低分"
            person={paper.bottom}
            detail={`${Number(paper.bottom?.score)}/${Number(paper.full_score)}`}
            note={percentText(paper.bottom?.percent)}
            empty="还没有出分的成绩"
          />
          <Person
            label="进步最大"
            person={improved}
            detail={
              improved
                ? `上次 ${percentText(improved.prev_percent)} → 这次 ${percentText(improved.percent)}`
                : null
            }
            note={improved ? `得分率 +${Math.round(Number(improved.delta) * 1000) / 10} 个百分点` : null}
            empty="没有可比的上一场"
          />
        </div>

        {/* 一个人都没出分时不画分布：五行全 0 的条只是噪音，上面那句"待阅卷"已经说清楚了 */}
        {Number(paper.participants) > 0 && <ScoreDistribution rows={paper.distribution ?? []} />}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <Link
            className="text-primary hover:underline"
            href={`/papers/${paper.paper_id}/board?scope=class&class=${classId}`}
          >
            看这份卷的成绩榜 ›
          </Link>
          <Link
            className="text-primary hover:underline"
            href={`/lecture/paper/${paper.paper_id}?scope=class&class=${classId}`}
          >
            讲评模式 ›
          </Link>
          <Link
            className="text-primary hover:underline"
            href={`/classes/${classId}/ai/${paper.paper_id}`}
          >
            AI 分析 ›
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}

// 一个人 + 一句说明。没有数据时给"为什么没有"，而不是留白（同 viewer_note 的规矩）。
function Person({ label, person, detail, note, empty }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      {person ? (
        <>
          <p className="mt-0.5 truncate text-sm font-medium" title={person.name}>
            {person.name}
            {detail && (
              <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{detail}</span>
            )}
          </p>
          {note && <p className="text-xs text-muted-foreground tabular-nums">{note}</p>}
        </>
      ) : (
        <p className="mt-0.5 text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  )
}
