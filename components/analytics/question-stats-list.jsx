import { accuracyClass, OptionDistribution } from "@/components/analytics/option-distribution"
import { EasilyWrongBadge } from "@/components/analytics/easily-wrong-badge"
import { percentText } from "@/lib/analytics"
import { isHighError, MIN_ATTEMPTS_HIGH_ERROR } from "@/lib/accuracy"
import { qtypeShortLabel } from "@/lib/question-model"

// 逐题分析：默认折叠，点开看选项分布与错答名单。
//
// 用原生 <details> 而不是自己的折叠组件：一页可能有几十道题，
// 用 HTML 自带的能力就不必为此引入客户端 JS（这一页因此仍是不含 "use client" 的服务端组件）。
//
// 每题一行摘要（题号 / 题型 / 正确率 / 作答人数 / 错答人数 / 易错标识）＋ 展开后的细节：
// 选项分布（含"谁选了它"）、填空题的答案频次、错答名单。
//
// **这里用的是卷内口径**（本场/本班考这份卷子的人），不是题库那条全站口径：
// 样本量取 `graded`（判过分的人数），少于 MIN_ATTEMPTS_HIGH_ERROR 不标易错。
export function QuestionStatsList({ items, studentLimit }) {
  if (!items?.length) {
    return (
      <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
        这份卷子还没有可统计的作答。
      </p>
    )
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        // 卷内口径的易错判定：错误率 = 1 - 正确率，样本 = 判过分的人数
        const easilyWrong =
          item.correct_rate != null && isHighError(1 - Number(item.correct_rate), item.graded)
        return (
        <li key={item.item_id} className="rounded-xl border">
          <details className="group">
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm marker:content-none">
              <span className="font-medium tabular-nums">第 {item.seq} 题</span>
              <span className="text-xs text-muted-foreground">
                {Number(item.score)} 分 · 作答 {Number(item.total) - Number(item.blank)}/
                {Number(item.total)}
                {Number(item.blank) > 0 ? ` · 未答 ${item.blank}` : ""}
              </span>
              {easilyWrong && (
                <EasilyWrongBadge
                  title={`本卷错误率 ≥60% 且至少 ${MIN_ATTEMPTS_HIGH_ERROR} 人判过分`}
                />
              )}
              {/* 0 次作答（还没人判到这道题）显示「—」而不是 0%——同 lib/accuracy.js 的规矩 */}
              <span className={`ml-auto tabular-nums font-medium ${accuracyClass(item.correct_rate)}`}>
                正确率 {percentText(item.correct_rate)}
              </span>
              {Number(item.wrong_total) > 0 && (
                <span className="text-xs text-muted-foreground">
                  错 {item.wrong_total} 人次
                </span>
              )}
              {Number(item.pending) > 0 && (
                <span className="text-xs text-amber-600">待阅卷 {item.pending}</span>
              )}
            </summary>

            <div className="space-y-3 border-t px-3 py-3">
              {/* 题干：展开后要能直接对着题读，不必回成绩单翻原题。
                  用 whitespace-pre-wrap 保留原文换行（材料题与填空的横线都靠换行对齐）。 */}
              {item.stem_text && (
                <div className="rounded-lg bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap wrap-break-word">
                  <p className="mb-1 text-xs text-muted-foreground">题干</p>
                  {item.stem_text}
                </div>
              )}

              {/* 综合题：逐小题 / 逐空。整题正确率在摘要里，这里看的是"错在哪一问"。 */}
              {item.subs?.length > 0 && <SubQuestionStats subs={item.subs} />}

              <OptionDistribution options={item.options} studentLimit={studentLimit} />

              {/* 填空题：只给答案频次，不给姓名（自由文本可能含隐私，见 0078 的注释） */}
              {item.text_counts?.length > 0 && (
                <div className="text-sm">
                  <p className="mb-1 text-xs text-muted-foreground">
                    学生填的内容（只统计频次，不显示是谁填的）
                  </p>
                  <ul className="space-y-0.5">
                    {item.text_counts.slice(0, 10).map((t, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="tabular-nums text-muted-foreground">{t.count} 人</span>
                        <span className="min-w-0 flex-1 truncate">{t.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {item.wrong_students?.length > 0 && (
                <div className="text-sm">
                  <p className="mb-1 text-xs text-muted-foreground">
                    答错的 {item.wrong_total} 人
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {item.wrong_students.map((s) => (
                      <li
                        key={s.user_id}
                        className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {s.name}
                        {s.label ? `（选了 ${s.label}）` : ""}
                        {s.class_name ? ` · ${s.class_name}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        </li>
        )
      })}
    </ul>
  )
}

// 综合题的逐小题 / 逐空统计。
//
// 正确率的分母是**作答人数**（answered），不是总人数：没填的空算"未作答"，
// 不该被算成答错（服务端口径见迁移 0109）。所以每行都同时给出"作答 x/y"。
function SubQuestionStats({ subs }) {
  return (
    <div className="space-y-3 rounded-lg border border-dashed px-3 py-2">
      <p className="text-xs text-muted-foreground">
        综合题逐小题统计（正确率按作答人数算，未作答不计入分母）
      </p>
      {subs.map((sub) => (
        <div key={sub.index} className="space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="font-medium">第 {sub.index} 小题</span>
            <span className="text-xs text-muted-foreground">{qtypeShortLabel(sub.type)}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              作答 {Number(sub.answered)}/{Number(sub.total)}
              {Number(sub.blank) > 0 ? ` · 未答 ${sub.blank}` : ""}
            </span>
            <span className={`ml-auto tabular-nums font-medium ${accuracyClass(sub.correct_rate)}`}>
              正确率 {percentText(sub.correct_rate)}
            </span>
          </div>
          {sub.stem_text && (
            <p className="whitespace-pre-wrap wrap-break-word text-sm">{sub.stem_text}</p>
          )}
          {sub.blanks?.length > 0 && (
            <ul className="space-y-0.5 pl-3 text-xs text-muted-foreground">
              {sub.blanks.map((blank) => (
                <li key={blank.index} className="flex flex-wrap items-baseline gap-x-2">
                  <span>第 {blank.index} 空</span>
                  <span className="tabular-nums">
                    答对 {Number(blank.correct)}/{Number(blank.answered)}
                  </span>
                  <span className={`tabular-nums ${accuracyClass(blank.correct_rate)}`}>
                    {percentText(blank.correct_rate)}
                  </span>
                  {Number(blank.total) > Number(blank.answered) && (
                    <span className="tabular-nums">
                      未答 {Number(blank.total) - Number(blank.answered)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
