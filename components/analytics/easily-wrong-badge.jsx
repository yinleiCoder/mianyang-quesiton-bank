import { Badge } from "@/components/ui/badge"

// 「易错」标识。判据不在这里 —— 调用方用 lib/accuracy.js 的 isHighError / isEasilyWrong
// 判完再决定渲染不渲染（那样才有单一真源；把阈值塞进组件里，四个面迟早各标各的）。
//
// 为什么值得单独一个组件：题库列表、题目详情、讲评看板、讲评模式四处都要它，
// 颜色/文案各写一遍必然漂移。
export function EasilyWrongBadge({ className = "", title }) {
  return (
    <Badge
      className={
        "bg-rose-100 px-1.5 py-0 text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-300 " +
        className
      }
      title={title}
    >
      易错
    </Badge>
  )
}
