"use client"

// 展示页通用画布壳。写法对齐 components/review/approval-flow-canvas.jsx：
// Provider + fitView + Controls + Background，节点不可拖动，画布可平移/缩放。
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { nodeTypes } from "./flow-nodes"
import { edgeTypes } from "./ant-edge"

export function ShowcaseFlow({ nodes, edges, ariaLabel }) {
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className="w-full overflow-hidden rounded-xl border bg-muted/10"
      style={{ height: "clamp(440px, calc(100dvh - 16rem), 860px)" }}
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.08, minZoom: 0.32, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant="dots" gap={20} size={1} color="var(--border)" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
