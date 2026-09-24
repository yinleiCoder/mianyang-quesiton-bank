import { accuracyClass, OptionDistribution } from "@/components/analytics/option-distribution"
import { percentText } from "@/lib/analytics"

// 逐题分析：默认折叠，点开看选项分布与错答名单。
//
// 用原生 <details> 而不是自己的折叠组件：一页可能有几十道题，
// 用 HTML 自带的能力就不必为此引入客户端 JS（这一页因此仍是不含 "use client" 的服务端组件）。
//
// 每题一行摘要（题号 / 题型 / 正确率 / 作答人数）＋ 展开后的细节：
// 选项分布（含"谁选了它"）、填空题的答案频次、错答名单。
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
      {items.map((item) => (
        <li key={item.item_id} className="rounded-xl border">
          <details className="group">
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm marker:content-none">
              <span className="font-medium tabular-nums">第 {item.seq} 题</span>
              <span className="text-xs text-muted-foreground">
                {Number(item.score)} 分 · 作答 {Number(item.total) - Number(item.blank)}/
                {Number(item.total)}
                {Number(item.blank) > 0 ? ` · 未答 ${item.blank}` : ""}
              </span>
              {/* 0 次作答（还没人判到这道题）显示「—」而不是 0%——同 lib/accuracy.js 的规矩 */}
              <span className={`ml-auto tabular-nums font-medium ${accuracyClass(item.correct_rate)}`}>
                正确率 {percentText(item.correct_rate)}
              </span>
              {Number(item.pending) > 0 && (
                <span className="text-xs text-amber-600">待阅卷 {item.pending}</span>
              )}
            </summary>

            <div className="space-y-3 border-t px-3 py-3">
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
      ))}
    </ul>
  )
}
