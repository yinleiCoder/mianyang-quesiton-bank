// 科学抽题动画专用原语：曲线图、进度条、公式块。
//
// 与 components/showcase/primitives.jsx 同一条规矩：所有动效由 useCurrentFrame 驱动，
// 不用 CSS keyframes / transition —— 任意 seekTo 一帧都能确定性重放。
import { interpolate, useCurrentFrame } from "remotion"
import { STAGE } from "@/components/showcase/primitives"

const clamp01 = (value) => Math.min(1, Math.max(0, value))

// 把 [start, start + duration] 映射成 0→1，超出范围夹住。
export function useReveal(start = 0, duration = 20) {
  const frame = useCurrentFrame()
  return clamp01(interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }))
}

export function Formula({ children, note, tone = "#6d28d9" }) {
  return (
    <div
      style={{
        border: `1px solid ${tone}33`,
        background: `${tone}0d`,
        borderRadius: 12,
        padding: "12px 16px",
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        color: STAGE.fg,
      }}
    >
      <div style={{ fontSize: 20, lineHeight: 1.5 }}>{children}</div>
      {note ? (
        <div style={{ fontSize: 14, color: STAGE.muted, marginTop: 6, lineHeight: 1.45 }}>
          {note}
        </div>
      ) : null}
    </div>
  )
}

export function Meter({ value, tone = "#6d28d9", width = 260, height = 12, caption }) {
  const v = clamp01(value)
  return (
    <div style={{ width }}>
      <div
        style={{
          height,
          borderRadius: 999,
          background: "#ebebe6",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${v * 100}%`,
            height: "100%",
            borderRadius: 999,
            background: tone,
          }}
        />
      </div>
      {caption ? (
        <div style={{ fontSize: 13, color: STAGE.muted, marginTop: 4 }}>{caption}</div>
      ) : null}
    </div>
  )
}

// 折线图：SVG pathLength=1 + strokeDashoffset 做"逐帧画出来"的效果，
// 不依赖测量真实路径长度，跳到任意帧都正确。
//
// curves: [{ key, color, points: [{ x, y }] }]
// domain: { xMax, yMax }（x/y 都从 0 起，省掉负半轴）
export const DEFAULT_CHART_PADDING = { top: 24, right: 24, bottom: 44, left: 56 }

// 调用方要自己画标注线（90% 目标线、到期点）时，用同一套比例尺，
// 否则标注会和曲线错位。
export function chartScale(domain, width, height, padding = DEFAULT_CHART_PADDING) {
  const innerW = width - padding.left - padding.right
  const innerH = height - padding.top - padding.bottom
  return {
    padding,
    sx: (x) => padding.left + (x / domain.xMax) * innerW,
    sy: (y) => padding.top + (1 - y / domain.yMax) * innerH,
  }
}

export function CurveChart({
  curves,
  domain,
  width = 760,
  height = 420,
  reveal = 1,
  padding = DEFAULT_CHART_PADDING,
  xLabel,
  yLabel,
  yFormat = (tick) => `${Math.round(tick * 100)}%`,
  children,
}) {
  const innerW = width - padding.left - padding.right
  const { sx, sy } = chartScale(domain, width, height, padding)

  const yTicks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= domain.yMax)
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(domain.xMax * t))

  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      {yTicks.map((tick) => (
        <g key={`y${tick}`}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={sy(tick)}
            y2={sy(tick)}
            stroke={STAGE.line}
            strokeWidth={1}
          />
          <text
            x={padding.left - 10}
            y={sy(tick) + 5}
            textAnchor="end"
            fontSize={14}
            fill={STAGE.muted}
          >
            {yFormat(tick)}
          </text>
        </g>
      ))}
      {/* key 带上下标：xMax 很小时（信息增益那张图是 0–1）四个刻度会取整成重复值 */}
      {xTicks.map((tick, index) => (
        <text
          key={`x${index}`}
          x={sx(tick)}
          y={height - padding.bottom + 26}
          textAnchor="middle"
          fontSize={14}
          fill={STAGE.muted}
        >
          {tick}
        </text>
      ))}

      {curves.map((curve) => {
        const d = curve.points
          .map((point, index) => `${index === 0 ? "M" : "L"}${sx(point.x)} ${sy(point.y)}`)
          .join(" ")
        return (
          <path
            key={curve.key}
            d={d}
            fill="none"
            stroke={curve.color}
            strokeWidth={curve.width ?? 3}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - clamp01(reveal)}
            opacity={curve.opacity ?? 1}
          />
        )
      })}

      {children ? <g>{children}</g> : null}

      {xLabel ? (
        <text
          x={padding.left + innerW}
          y={height - 6}
          textAnchor="end"
          fontSize={14}
          fill={STAGE.muted}
        >
          {xLabel}
        </text>
      ) : null}
      {yLabel ? (
        <text x={padding.left} y={14} fontSize={14} fill={STAGE.muted}>
          {yLabel}
        </text>
      ) : null}
    </svg>
  )
}

export function Dot({ x, y, color, r = 6, label, labelDy = -14 }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill="#fff" stroke={color} strokeWidth={3} />
      {label ? (
        <text x={x} y={y + labelDy} textAnchor="middle" fontSize={14} fill={color} fontWeight={600}>
          {label}
        </text>
      ) : null}
    </g>
  )
}

export function Legend({ items }) {
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 15, color: STAGE.muted }}>
      {items.map((item) => (
        <span key={item.label} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 14, height: 4, borderRadius: 999, background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  )
}

// 大字报式的一句话结论条
export function Takeaway({ children, tone = "#047857" }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        borderRadius: 12,
        border: `1px solid ${tone}33`,
        background: `${tone}0f`,
        color: tone,
        padding: "10px 16px",
        fontSize: 20,
        fontWeight: 600,
      }}
    >
      <span
        style={{ width: 8, height: 8, borderRadius: 999, background: tone, flexShrink: 0 }}
      />
      {children}
    </div>
  )
}
