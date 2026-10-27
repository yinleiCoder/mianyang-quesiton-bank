"use client"

import { MarkerType } from "@xyflow/react"
import {
  PUBLISHED_NODE,
  ROLE_EDGES,
  ROLE_LANES,
  ROLE_LAYOUT,
  ROLE_POSITIONS,
  SHOWCASE_ROLES,
  TEAM_EDGES,
} from "@/lib/showcase-roles"
import { SHOWCASE_TEAM } from "@/lib/showcase-team"
import { toneCss } from "@/lib/showcase-palette"
import { ShowcaseFlow } from "./showcase-flow"

const LANE_NODES = [
  {
    id: "lane-system",
    type: "lane",
    position: { x: 0, y: 0 },
    data: ROLE_LANES[0],
    style: { width: ROLE_LAYOUT.width, height: ROLE_LAYOUT.systemHeight, pointerEvents: "none" },
    zIndex: 0,
    draggable: false,
    selectable: false,
    connectable: false,
  },
  {
    id: "lane-team",
    type: "lane",
    position: { x: 0, y: ROLE_LAYOUT.teamY },
    data: ROLE_LANES[1],
    style: { width: ROLE_LAYOUT.width, height: ROLE_LAYOUT.teamHeight, pointerEvents: "none" },
    zIndex: 0,
    draggable: false,
    selectable: false,
    connectable: false,
  },
]

const ROLE_NODES = [...SHOWCASE_ROLES, PUBLISHED_NODE].map((role) => ({
  id: role.id,
  type: "role",
  position: ROLE_POSITIONS[role.id],
  data: { ...role, width: ROLE_LAYOUT.roleW },
  zIndex: 1,
  draggable: false,
  selectable: false,
  connectable: false,
}))

const TEAM_NODES = SHOWCASE_TEAM.map((member) => ({
  id: member.id,
  type: "team",
  position: ROLE_POSITIONS[member.id],
  data: { ...member, width: ROLE_LAYOUT.teamW },
  zIndex: 1,
  draggable: false,
  selectable: false,
  connectable: false,
}))

const FLOW_NODES = [...LANE_NODES, ...ROLE_NODES, ...TEAM_NODES]

const FLOW_EDGES = [...ROLE_EDGES, ...TEAM_EDGES].map((edge) => {
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

export function RolesFlow() {
  return <ShowcaseFlow nodes={FLOW_NODES} edges={FLOW_EDGES} ariaLabel="人员层级管理结构图" />
}
