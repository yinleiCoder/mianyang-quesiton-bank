import { cn } from "cn"

// 支持 minRows（最小可见行数 → 最小高度）：正文用 field-sizing:content 自动随内容增高，
// minRows 只约束空/短内容时的起始高度，不落入 DOM（textarea 无此原生属性，直传会触发
// React 警告）。用 1lh 计算随响应式字号（text-base/md:text-sm）自适应；min-h-16 兜底。
function Textarea({
  className,
  minRows,
  style,
  ...props
}) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      style={
        minRows != null
          ? { minHeight: `calc(${minRows} * 1lh + 1rem + 2px)`, ...(style ?? {}) }
          : style
      }
      {...props}
    />
  )
}

export { Textarea }
