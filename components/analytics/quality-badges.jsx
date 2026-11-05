// CTT 标记的紧凑展示：徽标只放短标签，完整原因放 title 与下方列表。
import { Badge } from "@/components/ui/badge"

const LABELS = {
  too_hard: "偏难",
  too_easy: "偏易",
  poor_discrimination: "区分度差",
  weak_discrimination: "区分度偏弱",
  high_blank: "未答多",
  key_never_chosen: "答案存疑",
  strong_distractor: "强干扰",
  dead_distractor: "无效干扰",
  insufficient: "样本不足",
  small_sample: "样本偏少",
}

const STYLES = {
  error: "bg-rose-100 text-rose-700",
  warn: "bg-amber-100 text-amber-700",
  info: "bg-sky-100 text-sky-700",
  muted: "bg-muted text-muted-foreground",
}

export function QualityBadges({ flags }) {
  if (!flags?.length) return null
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((flag, index) => (
        <Badge
          key={`${flag.code}-${index}`}
          variant="secondary"
          className={`font-normal ${STYLES[flag.severity] ?? ""}`}
          title={flag.message}
        >
          {LABELS[flag.code] ?? flag.code}
        </Badge>
      ))}
    </div>
  )
}

export function QualityMessages({ flags }) {
  const important = (flags ?? []).filter(
    (flag) => flag.severity === "warn" || flag.severity === "error"
  )
  if (!important.length) return null
  return (
    <ul className="space-y-0.5 text-xs">
      {important.map((flag, index) => (
        <li key={`${flag.code}-${index}`} className="text-muted-foreground">
          · {flag.message}
        </li>
      ))}
    </ul>
  )
}
