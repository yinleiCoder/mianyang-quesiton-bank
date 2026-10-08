import { cn } from "cn"
import { Skeleton } from "@/components/ui/skeleton"

// 骨架屏的组合件。
//
// 为什么要这一层：形状得跟着页面走（列表行 / 表格 / 卡片 / 数字块），而"加载中…"这四个字
// 既不说加载的是什么，也让布局在数据到位时整体跳一下。基元还是 shadcn 的 <Skeleton>
// （components/ui/skeleton.jsx），这里只负责把它拼成页面的样子。
//
// 三条约定：
//   · 每个组合件都带 `aria-hidden`，由调用方在容器上给 `aria-busy`/`sr-only` 文案
//     —— 屏幕阅读器念一串空 div 没有意义（见 app/(app)/loading.jsx 的做法）；
//   · 行数/列数给默认值但都可以覆盖，让骨架**贴近真实内容的体量**（三行 vs 十行是两种观感）；
//   · 不做动画以外的花样：`animate-pulse` 由 <Skeleton> 自带（顺带说明：它一直动，
//     没有 prefers-reduced-motion 降级——这是产品的明确口径，见 components/ui/reveal.jsx）。

/** 列表行：左边头像/图标位，中间两行文字，右侧一个数值。题库、名册、审核队列都是这个形。 */
export function SkeletonRows({ rows = 5, className }) {
  return (
    <div className={cn("space-y-1.5", className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border px-3 py-2">
          <Skeleton className="size-7 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={cn("h-3.5", i % 3 === 0 ? "w-3/5" : i % 3 === 1 ? "w-4/5" : "w-2/5")} />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-3.5 w-12 shrink-0" />
        </div>
      ))}
    </div>
  )
}

/** 表格：表头一行 + 若干行等宽单元格。列宽故意不等，比清一色的灰条更像真表。 */
export function SkeletonTable({ rows = 8, cols = 4, className }) {
  const widths = ["w-1/3", "w-1/5", "w-1/4", "w-1/6", "w-1/5", "w-1/4"]
  return (
    <div className={cn("overflow-hidden rounded-xl border", className)} aria-hidden="true">
      <div className="flex items-center gap-3 border-b bg-muted/30 px-3 py-2">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-3 px-3 py-2.5">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className={cn("h-3.5 flex-1", widths[(r + c) % widths.length])} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 卡片组：每张卡一个标题 + 两行内容（班级看板、试卷库、首页工作台都是这个形）。 */
export function SkeletonCards({ count = 3, className }) {
  return (
    <div className={cn("space-y-3", className)} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-xl border p-4">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-48 max-w-[60%]" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-3 w-2/3" />
          <div className="grid gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((k) => (
              <Skeleton key={k} className="h-14 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-2.5 w-full rounded-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * 整页骨架：标题 + 一排数字块 + 一块内容。给路由级 loading.jsx 用。
 * 与 app/(app)/loading.jsx 的兜底骨架同一形状，只是块数可以按页面调。
 */
export function SkeletonPage({ tiles = 4, blocks = [56, 40], className }) {
  return (
    <div className={cn("space-y-4", className)} aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {tiles > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: tiles }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      )}
      {blocks.map((h, i) => (
        <Skeleton key={i} className="rounded-xl" style={{ height: `${h * 4}px` }} />
      ))}
    </div>
  )
}
