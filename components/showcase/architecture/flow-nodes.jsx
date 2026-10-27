"use client"

// React Flow 自定义节点。节点固定宽度 + truncate/line-clamp，避免长文案撑破画布。
import { Handle, Position } from "@xyflow/react"
import { SHOWCASE_ICONS } from "@/components/showcase/showcase-icons"

const TONE = {
  sky: {
    border: "border-sky-200/80 dark:border-sky-900",
    icon: "text-sky-700 dark:text-sky-300",
    chip: "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-200",
  },
  violet: {
    border: "border-violet-200/80 dark:border-violet-900",
    icon: "text-violet-700 dark:text-violet-300",
    chip: "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-200",
  },
  emerald: {
    border: "border-emerald-200/80 dark:border-emerald-900",
    icon: "text-emerald-700 dark:text-emerald-300",
    chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200",
  },
  amber: {
    border: "border-amber-200/80 dark:border-amber-900",
    icon: "text-amber-700 dark:text-amber-300",
    chip: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  },
  rose: {
    border: "border-rose-200/80 dark:border-rose-900",
    icon: "text-rose-700 dark:text-rose-300",
    chip: "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-200",
  },
  slate: {
    border: "border-border",
    icon: "text-muted-foreground",
    chip: "bg-muted text-muted-foreground",
  },
}

// 四个方向各放 source/target 两个 Handle，边数据里按需选 id。
function NodeHandles() {
  return (
    <>
      <Handle id="t" type="target" position={Position.Top} className="opacity-0!" isConnectable={false} />
      <Handle id="ts" type="source" position={Position.Top} className="opacity-0!" isConnectable={false} />
      <Handle id="r" type="target" position={Position.Right} className="opacity-0!" isConnectable={false} />
      <Handle id="rs" type="source" position={Position.Right} className="opacity-0!" isConnectable={false} />
      <Handle id="b" type="target" position={Position.Bottom} className="opacity-0!" isConnectable={false} />
      <Handle id="bs" type="source" position={Position.Bottom} className="opacity-0!" isConnectable={false} />
      <Handle id="l" type="target" position={Position.Left} className="opacity-0!" isConnectable={false} />
      <Handle id="ls" type="source" position={Position.Left} className="opacity-0!" isConnectable={false} />
    </>
  )
}

function IconFor({ icon, className }) {
  const Icon = SHOWCASE_ICONS[icon] ?? SHOWCASE_ICONS.fallback
  return <Icon className={className} />
}

export function ArchNode({ data }) {
  const t = TONE[data.tone] ?? TONE.slate
  return (
    <div
      className={`rounded-xl border bg-card p-3 shadow-sm ${t.border}`}
      style={{ width: data.width ?? 240 }}
    >
      <NodeHandles />
      <div className="flex items-start gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <IconFor icon={data.icon} className={`size-5 ${t.icon}`} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold" title={data.title}>{data.title}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground" title={data.subtitle}>{data.subtitle}</p>
        </div>
      </div>
      {data.badges?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {data.badges.map((badge) => (
            <span key={badge} className={`rounded px-1.5 py-0.5 text-[10px] ${t.chip}`}>
              {badge}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function RoleNode({ data }) {
  const t = TONE[data.tone] ?? TONE.slate
  return (
    <div
      className={`rounded-xl border bg-card p-2.5 shadow-sm ${t.border}`}
      style={{ width: data.width ?? 236 }}
    >
      <NodeHandles />
      <div className="flex items-center gap-2">
        <IconFor icon={data.icon} className={`size-4 shrink-0 ${t.icon}`} />
        <p className="truncate text-sm font-semibold" title={data.title}>{data.title}</p>
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground" title={data.scope}>{data.scope}</p>
      <p className="mt-1 line-clamp-1 text-[11px]" title={data.duties}>{data.duties}</p>
      {data.appoints ? (
        <p className={`mt-1 line-clamp-1 text-[10px] ${t.icon}`} title={data.appoints}>{data.appoints}</p>
      ) : null}
      {data.limit ? (
        <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground" title={data.limit}>{data.limit}</p>
      ) : null}
    </div>
  )
}

export function TeamNode({ data }) {
  const t = TONE[data.tone] ?? TONE.slate
  return (
    <div
      className={`rounded-xl border bg-card p-2.5 shadow-sm ${t.border}`}
      style={{ width: data.width ?? 220 }}
    >
      <NodeHandles />
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-semibold" title={data.title}>{data.title}</p>
        <IconFor icon={data.icon} className={`size-4 shrink-0 ${t.icon}`} />
      </div>
      <p className="mt-0.5 text-xs font-medium">{data.owner}</p>
      <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground" title={data.duties}>{data.duties}</p>
      {data.note ? (
        <p className="mt-1 line-clamp-1 text-[10px] text-muted-foreground" title={data.note}>{data.note}</p>
      ) : null}
    </div>
  )
}

export function LaneNode({ data }) {
  const t = TONE[data.tone] ?? TONE.slate
  return (
    <div className={`h-full w-full rounded-2xl border border-dashed ${t.border} bg-muted/10 px-4 py-2.5`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground">{data.title}</span>
        <span className="text-[11px] text-muted-foreground/70">{data.subtitle}</span>
      </div>
    </div>
  )
}

export const nodeTypes = {
  arch: ArchNode,
  role: RoleNode,
  team: TeamNode,
  lane: LaneNode,
}
