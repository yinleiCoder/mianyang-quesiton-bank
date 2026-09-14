import { cn } from "cn"

// 页面标题区：全站统一的 h1 + 说明文案排版（此前 16 个页面各写一遍同样的类名）。
// centered 用于 (auth) 两页（居中卡片内的标题），其余页面用默认左对齐。
// title/description 接受 ReactNode：部分页面需要条件文案或内嵌强调样式。
export function PageHeader({ title, description, centered = false, className = "" }) {
  return (
    <div
      className={cn(
        centered ? "flex flex-col items-center gap-2 text-center" : "space-y-1",
        className
      )}
    >
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}
