"use client"

import { MarkerType } from "@xyflow/react"
import {
  ARCH_EDGES,
  ARCH_LANES,
  ARCH_LAYOUT,
  ARCH_NODES,
  archLanePosition,
  archNodePosition,
} from "@/lib/showcase-architecture"
import { toneCss } from "@/lib/showcase-palette"
import { ShowcaseFlow } from "./showcase-flow"

const LANE_NODES = ARCH_LANES.map((lane, index) => ({
  id: `lane-${lane.id}`,
  type: "lane",
  position: archLanePosition(index),
  data: lane,
  style: { width: ARCH_LAYOUT.laneW, height: ARCH_LAYOUT.laneH, pointerEvents: "none" },
  zIndex: 0,
  draggable: false,
  selectable: false,
  connectable: false,
}))

const FLOW_NODES = [
  ...LANE_NODES,
  ...ARCH_NODES.map((node) => ({
    id: node.id,
    type: "arch",
    position: archNodePosition(node),
    data: { ...node, width: ARCH_LAYOUT.nodeW },
    zIndex: 1,
    draggable: false,
    selectable: false,
    connectable: false,
  })),
]

const FLOW_EDGES = ARCH_EDGES.map((edge) => {
  const color = toneCss(edge.tone)
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "ant",
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    data: { ...edge, color },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
  }
})

export function ArchitectureFlow() {
  return <ShowcaseFlow nodes={FLOW_NODES} edges={FLOW_EDGES} ariaLabel="软件架构图" />
}
