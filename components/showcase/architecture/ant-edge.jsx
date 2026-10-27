"use client"

// 双层路径的蚂蚁线边：底层是低透明度实线（可带静态虚线），
// 上层是流动虚线。箭头只挂在底层，避免箭头被重复绘制。
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
} from "@xyflow/react"

export function AntEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data = {},
  markerEnd,
}) {
  const params = { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition }
  const [path, labelX, labelY] =
    data.pathKind === "bezier"
      ? getBezierPath({ ...params, curvature: 0.32 })
      : getSmoothStepPath({ ...params, borderRadius: 18, offset: 24 })

  const color = data.color ?? "var(--showcase-slate)"
  const width = data.width ?? 1.6
  const baseStyle = {
    stroke: color,
    strokeWidth: width,
    opacity: data.dashed ? 0.45 : 0.35,
  }
  if (data.dashed) baseStyle.strokeDasharray = "5 5"

  return (
    <>
      <BaseEdge id={id} path={path} style={baseStyle} markerEnd={markerEnd} />
      {data.animated !== false ? (
        <path
          d={path}
          className="showcase-ant-edge"
          style={{ stroke: color, strokeWidth: width + 0.7 }}
        />
      ) : null}
      {data.label ? (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded border bg-background/90 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-muted-foreground shadow-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const edgeTypes = { ant: AntEdge }
