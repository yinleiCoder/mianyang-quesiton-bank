// 整卷渲染（服务端组件，无 "use client"）：打印正卷、参考答案、试卷详情、审批详情四处共用。
//
// 安全边界：showAnswer 控制答案与解析是否进入 DOM。
// 正卷必须传 false 并把答案放到**独立路由**——不能靠 print:hidden 藏，
// 藏起来的 DOM 照样能被查看源码/复制，等于把答案随卷子一起发给了学生。
import { QuestionView } from "@/components/questions/question-view"
import { cnNumeral, sectionHeading, round2 } from "@/lib/paper-model"

// 卷头：考试名称 / 科目 / 总分 / 时长 / 姓名得分栏
function PaperHead({ snap }) {
  const header = snap.header ?? {}
  // 默认显示考生信息栏：正式考试卷都要填
  const showCandidateBar = header.show_candidate_bar !== false
  return (
    <header className="mb-5 border-b border-black/30 pb-4 text-center">
      {snap.exam_name && <p className="text-base font-medium tracking-wide">{snap.exam_name}</p>}
      <h1 className="mt-1 text-xl font-semibold tracking-wide">{snap.title}</h1>
      {snap.subject_label && <p className="mt-0.5 text-sm">{snap.subject_label}</p>}
      <p className="mt-2 text-sm">
        总分 {round2(snap.total_score)} 分
        <span className="mx-3">·</span>
        考试时间 {snap.duration_minutes} 分钟
        {header.code ? <span className="ml-3">（{header.code}）</span> : null}
      </p>
      {showCandidateBar && (
        <p className="mt-3 text-sm tracking-wide">
          姓名 <span className="inline-block w-28 border-b border-black/60" />
          <span className="mx-4" />
          学号 <span className="inline-block w-28 border-b border-black/60" />
          <span className="mx-4" />
          得分 <span className="inline-block w-20 border-b border-black/60" />
        </p>
      )}
    </header>
  )
}

// 卷首说明（与题目 content 的块结构同构，这里只渲染文字块——说明里不该有媒体）
function Instructions({ blocks }) {
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b?.t === "text" && b.text?.trim())
  if (list.length === 0) return null
  return (
    <div className="mb-5 space-y-1 border border-black/20 bg-black/[0.02] p-3 text-sm leading-relaxed">
      {list.map((b, i) => (
        <p key={i} className="whitespace-pre-wrap">
          {b.text}
        </p>
      ))}
    </div>
  )
}

function ItemBlock({ item, seq, qtype }) {
  return (
    <div className="break-inside-avoid">
      <div className="flex items-start gap-2">
        <span className="shrink-0 font-medium tabular-nums">{seq}.</span>
        <div className="min-w-0 flex-1">
          <QuestionView qtype={qtype} content={item.content} showAnswer={false} variant="paper" />
        </div>
      </div>
    </div>
  )
}

export function PaperSheet({ snapshot, mode = "paper" }) {
  const sections = snapshot?.sections ?? []
  const withAnswers = mode === "answers"

  return (
    <article className="text-black">
      <PaperHead snap={snapshot} />
      <Instructions blocks={snapshot?.instructions} />

      {sections.length === 0 && (
        <p className="py-10 text-center text-sm text-black/50">这份试卷还没有题目</p>
      )}

      {sections.map((sec, si) => (
        <section key={sec.id ?? si} className="mb-6">
          <h2 className="mb-2 break-after-avoid font-semibold leading-relaxed">
            {sectionHeading(sec, si)}
          </h2>
          {sec.instruction && (
            <p className="mb-2 text-sm text-black/70">{sec.instruction}</p>
          )}
          <div className="space-y-4">
            {withAnswers
              ? (sec.items ?? []).map((it, ii) => (
                  <AnswerBlock key={it.id ?? ii} item={it} />
                ))
              : (sec.items ?? []).map((it) => (
                  <ItemBlock key={it.id} item={it} seq={it.seq} qtype={it.qtype} />
                ))}
          </div>
        </section>
      ))}

      {withAnswers && <ScoreTable sections={sections} snapshot={snapshot} />}
    </article>
  )
}

// 参考答案里每题带"评分标准"：把计分点拆开写出来，阅卷人照着给分。
// score_units 是服务端物化的权威数据，这里只负责展示，不重算。
function AnswerBlock({ item }) {
  return (
    <div className="break-inside-avoid border-l-2 border-black/15 pl-3">
      <div className="mb-1 flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-medium tabular-nums">{item.seq}.</span>
        <span className="text-black/60">
          （{round2(item.score)} 分
          {item.score_units?.length > 1 ? `，共 ${item.score_units.length} 个给分点` : ""}）
        </span>
      </div>
      <QuestionView qtype={item.qtype} content={item.content} showAnswer variant="paper" />
      {item.score_units?.length > 1 && (
        <p className="mt-2 text-sm">
          评分标准：
          {item.score_units.map((u, i) => `${i + 1}. ${round2(u)} 分`).join("　")}
        </p>
      )}
    </div>
  )
}

// 卷末分数速查表：阅卷与登分时不用来回翻
function ScoreTable({ sections, snapshot }) {
  const rows = sections.flatMap((s) => s.items ?? [])
  if (rows.length === 0) return null
  return (
    <section className="mt-8 break-before-page">
      <h2 className="mb-2 font-semibold">分数构成</h2>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {sections.map((s, si) => (
            <tr key={s.id ?? si} className="border-b border-black/15">
              <td className="py-1 pr-3">
                {cnNumeral(si + 1)}、{s.title}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {s.items?.length ?? 0} 题
              </td>
              <td className="w-24 py-1 text-right tabular-nums">
                {round2(s.section_score)} 分
              </td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-1 pr-3">合计</td>
            <td className="py-1 pr-3 text-right tabular-nums">{rows.length} 题</td>
            <td className="py-1 text-right tabular-nums">{round2(snapshot.total_score)} 分</td>
          </tr>
        </tbody>
      </table>
    </section>
  )
}
