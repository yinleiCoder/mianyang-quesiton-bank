"use client"

// 头部面包屑：与侧栏收折按钮同排（shadcn 的 dashboard 块就是这个位置）。
// 末一节是当前页（不可点），前面几节可点回上一层；窄屏只留当前页，别把头部挤爆。
// 路径 → 轨迹的映射在 lib/breadcrumbs.js；没命中就退回品牌名，头部不会是空的。
import { Fragment } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { trailOf } from "@/lib/breadcrumbs"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

export function AppBreadcrumb() {
  const pathname = usePathname()
  const trail = trailOf(pathname)

  if (trail.length === 0) {
    return (
      <span className="truncate text-sm font-medium text-muted-foreground">
        绵阳市中职共建题库
      </span>
    )
  }

  return (
    <Breadcrumb className="min-w-0">
      {/* 单行显示：头部很矮，换行会把标题顶下去。min-w-0 是 truncate 生效的前提 */}
      <BreadcrumbList className="min-w-0 flex-nowrap">
        {trail.map((c, i) => {
          const last = i === trail.length - 1
          // 中间节窄屏隐藏（只剩当前页），与 dashboard 块一致
          const cls = last ? "truncate" : "hidden truncate md:block"
          return (
            <Fragment key={`${c.label}-${i}`}>
              {/* 分隔符是独立的 li，不能塞进 BreadcrumbItem 里（li 套 li） */}
              {i > 0 && <BreadcrumbSeparator className="hidden md:block" />}
              <BreadcrumbItem className="min-w-0">
                {last ? (
                  <BreadcrumbPage className={cls}>{c.label}</BreadcrumbPage>
                ) : c.href ? (
                  <BreadcrumbLink className={cls} render={<Link href={c.href} />}>
                    {c.label}
                  </BreadcrumbLink>
                ) : (
                  // 「管理台」这类没有落地页的前缀：纯文字，不做成假链接
                  <span className={cls}>{c.label}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
