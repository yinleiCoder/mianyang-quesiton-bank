import { cn } from "cn"
import { Reveal } from "@/components/ui/reveal"

// 页面标题区：全站统一的 h1 + 说明文案排版（此前 16 个页面各写一遍同样的类名）。
// centered 用于 (auth) 两页（居中卡片内的标题），其余页面用默认左对齐。
// title/description 接受 ReactNode：部分页面需要条件文案或内嵌强调样式。
//
// 入场动画挂在这里 = 全站每个页面都有一处一致的"进场"（见 components/ui/reveal.jsx 的规矩：
// 只做一次淡入上移、尊重 prefers-reduced-motion）。页面内部再需要分段入场时各自用 <Reveal>。
export function PageHeader({ title, description, centered = false, className = "" }) {
  return (
    <Reveal
      className={cn(
        centered ? "flex flex-col items-center gap-2 text-center" : "space-y-1",
        className
      )}
      y={6}
      duration={0.35}
    >
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
    </Reveal>
  )
}
