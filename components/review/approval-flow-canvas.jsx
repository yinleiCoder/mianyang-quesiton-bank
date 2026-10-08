"use client"

// 审批流程的**画布视图**（React Flow）：把"教师提交 → 教研组长 → 市级专家 → 入库"
// 画成一张有方向的图。同一份步骤数据还画着钉钉式的步骤条——两者并存不是冗余：
// 步骤条回答"走到哪一步了"，画布回答"整条链长什么样、谁把任务交给了谁"，
// 任务在岗位池里转派过几手之后，后者一眼就看得明白。
//
// 数据由调用方算好传进来（steps），这里只负责画。刻意不在这里读库：
// 审批可见性是 RLS 说了算（组长看不到专家那一行），把"谁能看到什么"再实现一遍必然跑偏。
//
// 动画是刻意的（用户明确要生动感）：节点依次进场、已走过的边是流动的虚线、
// 当前待办的节点有一圈呼吸光。这是审批台，注意力该被引到"卡在谁那里"。
import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import gsap from "gsap"
import { fmtDateTime24 } from "@/lib/format"

const NODE_W = 208
const GAP_X = 76
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

// 状态 → 配色。与步骤条（review-detail 的 StepDot）同一套语义色，别各调各的。
const STATE = {
  done: { ring: "border-emerald-300 bg-emerald-50/70", dot: "bg-emerald-500", text: "text-emerald-700", label: "已通过" },
  halted: { ring: "border-rose-300 bg-rose-50/70", dot: "bg-rose-500", text: "text-rose-700", label: "已退回" },
  current: { ring: "border-amber-400 bg-amber-50 ring-4 ring-amber-100", dot: "bg-amber-500", text: "text-amber-700", label: "待处理" },
  pending: { ring: "border-border bg-background", dot: "bg-muted-foreground/40", text: "text-muted-foreground", label: "" },
}

function FlowNode({ data }) {
  const card = useRef(null)
  const s = STATE[data.state] ?? STATE.pending

  // 依次进场：动的是卡片自己（不是 React Flow 的节点容器）——那个容器的 transform
  // 归 React Flow 管，动它会和拖拽/缩放的位移打架。
  useIsoLayoutEffect(() => {
    if (!card.current) return
    const tween = gsap.from(card.current, {
      opacity: 0,
      y: 8,
      duration: 0.4,
      delay: (data.index ?? 0) * 0.08,
      ease: "power2.out",
      clearProps: "opacity,transform",
    })
    return () => tween.kill()
  }, [data.index])

  return (
    <div
      ref={card}
      className={`rounded-xl border px-3 py-2.5 shadow-sm ${s.ring}`}
      style={{ width: NODE_W }}
    >
      <Handle type="target" position={Position.Left} className="opacity-0!" />
      <div className="flex items-center gap-2">
        <span className="relative flex size-2.5 shrink-0">
          {data.state === "current" && (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75" />
          )}
          <span className={`relative inline-flex size-2.5 rounded-full ${s.dot}`} />
        </span>
        <span className="truncate text-sm font-medium" title={data.label}>
          {data.label}
        </span>
      </div>
      <div className="mt-1 space-y-0.5 pl-4.5 text-xs">
        {s.label && (
          <p className={`font-medium ${s.text}`}>
            {s.label}
            {/* 已通过但查不到是谁办的：RLS 只给当前用户看与他相关的行（专家看不到组长的
                通过行），这时状态是靠版本状态兜底推出来的——写明白，别让人以为数据丢了 */}
            {data.state === "done" && !data.by ? " · 记录不可见" : ""}
          </p>
        )}
        {data.by && <p className="truncate text-muted-foreground">{data.by}</p>}
        {data.assigned && !data.by && <p className="truncate text-muted-foreground">处理人：{data.assigned}</p>}
        {data.at && <p className="text-muted-foreground tabular-nums">{fmtDateTime24(data.at)}</p>}
        {data.comment && (
          <p className="line-clamp-2 text-muted-foreground" title={data.comment}>
            “{data.comment}”
          </p>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0!" />
    </div>
  )
}

const nodeTypes = { step: FlowNode }

function Flow({ steps }) {
  const { nodes, edges } = useMemo(() => {
    const nodes = steps.map((s, i) => ({
      id: s.id,
      type: "step",
      position: { x: i * (NODE_W + GAP_X), y: 0 },
      data: { ...s, index: i },
      draggable: false,
      connectable: false,
    }))
    // 边的颜色跟着"下游那一步"走：走过的是绿的，正在走的是琥珀色虚线，
    // 还没到的是灰的——一眼看出任务卡在哪一段。
    const edges = steps.slice(1).map((s, i) => {
      const active = s.state === "current"
      const color = active ? "#f59e0b" : s.state === "done" ? "#10b981" : "#d4d4d8"
      return {
        id: `e-${steps[i].id}-${s.id}`,
        source: steps[i].id,
        target: s.id,
        type: "smoothstep",
        animated: s.state === "done" || active,
        style: { stroke: color, strokeWidth: active ? 2 : 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      }
    })
    return { nodes, edges }
  }, [steps])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      minZoom={0.4}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={18} size={1} />
      {/* 控件放右下角：链条总是从左边开始，左下角那格会被第一个节点压住 */}
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  )
}

// 外层必须有 Provider：ReactFlowProvider 提供的是画布实例，直接渲染 ReactFlow 也能跑，
// 但 fitView 在节点尺寸量出来之前会算错，包一层更稳（科目树画布同款做法）。
export function ApprovalFlowCanvas({ steps, className = "h-[210px]" }) {
  if (!steps || steps.length === 0) return null
  return (
    <div className={`w-full overflow-hidden rounded-lg border bg-muted/20 ${className}`}>
      <ReactFlowProvider>
        <Flow steps={steps} />
      </ReactFlowProvider>
    </div>
  )
}
