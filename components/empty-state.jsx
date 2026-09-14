import { cn } from "cn"

// 内容区空态：图标 + 标题 + 说明（+ 可选操作区）。此前 7 处各写一遍同样的排版。
// 间距/图标尺寸按主流写法统一（原 review-inbox 的 size-8/opacity-40 已并入标准）。
// 需要更紧凑的场合（列表内的一行提示）仍直接写类名——那种形态只有一行字，包组件反而更绕。
export function EmptyState({ icon: Icon, title, description, action, className = "" }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center",
        className
      )}
    >
      {Icon ? <Icon className="size-10 text-muted-foreground/50" /> : null}
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description ? (
          <p className="max-w-md text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  )
}
