import Link from "next/link"
import { SCOPE_KEYS, SCOPE_LABELS, analyticsQueryString } from "@/lib/analytics"

// 全班 / 全校 / 全市 三个口径的切换（外加教师可见的班级切换）。
//
// 用 <Link> 而不是 Tabs 组件：全站的页签都是"换 URL = 换数据"（服务端按新参数重新装配），
// 这样刷新、分享、后退都成立（与 /papers、/questions/reports 的页签同一套做法）。
export function ScopeTabs({ paperId, scope, classId, classes = [], activeClassId = null }) {
  const chip = (active) =>
    `rounded-full px-3 py-1 text-sm transition-colors ${
      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/60"
    }`

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {SCOPE_KEYS.map((key) => {
          const qs = analyticsQueryString({ scope: key, classId })
          return (
            <Link
              key={key}
              href={qs ? `/papers/${paperId}/board?${qs}` : `/papers/${paperId}/board`}
              aria-current={key === scope ? "page" : undefined}
              className={chip(key === scope)}
            >
              {SCOPE_LABELS[key]}
            </Link>
          )
        })}
      </div>

      {/* 教师名下有多个班时给一排班级切换；只有一个班就不渲染（没得选，白占一行） */}
      {scope === "class" && classes.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">班级</span>
          {classes.map((c) => (
            <Link
              key={c.class_id}
              href={`/papers/${paperId}/board?${analyticsQueryString({
                scope: "class",
                classId: c.class_id,
              })}`}
              aria-current={c.class_id === activeClassId ? "page" : undefined}
              className={`rounded-full px-2.5 py-0.5 transition-colors ${
                c.class_id === activeClassId
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {c.class_name}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
