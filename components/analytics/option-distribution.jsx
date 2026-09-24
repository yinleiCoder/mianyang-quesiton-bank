import { LOW_CORRECT_RATE, percentText } from "@/lib/analytics"

// 一道选择题的选项分布：字母 + 文本 + 人数条 + 选它的人。
//
// 谁选了什么**是产品明确要的**（用户 2026-09-24：师生都能看到姓名），所以这里直接列名字；
// 人多时截断并在标题里说明——一份 50 人的卷子，某个热门错选项可能有 20 个名字。
//
// 纯 CSS 条形，不引图表库（同 students/student-detail.jsx 的判断）。
export function OptionDistribution({ options, studentLimit }) {
  if (!options?.length) return null
  // 百分比的分母用"选过任何选项的人"，不是全班：未作答的人不该把条形压扁
  const total = options.reduce((n, o) => n + (Number(o.count) || 0), 0)

  return (
    <ul className="space-y-2">
      {options.map((o) => {
        const count = Number(o.count) || 0
        const ratio = total > 0 ? count / total : 0
        const names = (o.students ?? []).map((s) => s.name).filter(Boolean)
        return (
          <li key={o.key} className="space-y-1">
            <div className="flex items-center gap-2 text-sm">
              <span
                className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${
                  o.is_answer
                    ? "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {o.key}
              </span>
              <span className="min-w-0 flex-1 truncate">{o.text || "（无文本）"}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {count} 人 · {percentText(ratio)}
              </span>
            </div>
            <div className="ml-8 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${o.is_answer ? "bg-emerald-400" : "bg-slate-300"}`}
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
            </div>
            {names.length > 0 && (
              <p className="ml-8 text-xs text-muted-foreground">
                选它的：{names.slice(0, 12).join("、")}
                {o.students_truncated || names.length > 12
                  ? ` 等 ${count} 人（最多显示 ${studentLimit} 人）`
                  : ""}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// 正确率的着色：与题库页的高错误率同一条线（见 LOW_CORRECT_RATE 的注释）
export function accuracyClass(correctRate) {
  if (correctRate == null) return "text-muted-foreground"
  return Number(correctRate) <= LOW_CORRECT_RATE ? "text-rose-600" : "text-emerald-600"
}
