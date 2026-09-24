import Link from "next/link"
import { TAB_KEYS, TAB_LABELS, analyticsQueryString } from "@/lib/analytics"

// 同一份卷子的两种看法：成绩排行（谁排第几）/ 试题分析（哪道题错得多）。
// 与 ScopeTabs 一样是"换 URL = 换数据"的链接式页签（服务端按新参数重新装配）。
export function BoardTabs({ paperId, tab, scope, classId }) {
  return (
    <div className="flex items-center gap-4 border-b">
      {TAB_KEYS.map((key) => {
        const active = key === tab
        const qs = analyticsQueryString({ tab: key, scope, classId })
        return (
          <Link
            key={key}
            href={qs ? `/papers/${paperId}/board?${qs}` : `/papers/${paperId}/board`}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-1 pb-2 text-sm transition-colors ${
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {TAB_LABELS[key]}
          </Link>
        )
      })}
    </div>
  )
}
