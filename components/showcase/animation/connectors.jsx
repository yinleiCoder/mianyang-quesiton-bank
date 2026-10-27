// 场景里的连接线：直线与二次贝塞尔曲线。全部帧驱动（progress / dotT 由调用方算），
// 不依赖 DOM 的 getPointAtLength，保证 Remotion 任意跳帧都能确定性重放。

export function Connector({
  x1, y1, x2, y2, color, progress = 1, dotT = 0.5, dashed = true, width = 3, showDot = true,
}) {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1
  const dotX = x1 + (x2 - x1) * dotT
  const dotY = y1 + (y2 - y1) * dotT
  return (
    <svg style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={width} opacity={0.28} strokeLinecap="round" />
      <line
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={dashed ? "10 10" : `${length * progress} ${length}`}
        strokeDashoffset={dashed ? -progress * 40 : 0}
        opacity={0.9}
      />
      {showDot ? <circle cx={dotX} cy={dotY} r={5} fill={color} /> : null}
    </svg>
  )
}

export function CurveConnector({
  x1, y1, cx, cy, x2, y2, color, progress = 1, dotT = 0.5, dashed = true, width = 3, showDot = true,
}) {
  const path = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`
  const t = dotT
  const mt = 1 - t
  const dotX = mt * mt * x1 + 2 * mt * t * cx + t * t * x2
  const dotY = mt * mt * y1 + 2 * mt * t * cy + t * t * y2
  return (
    <svg style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
      <path d={path} fill="none" stroke={color} strokeWidth={width} opacity={0.28} strokeLinecap="round" />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={dashed ? "10 10" : undefined}
        strokeDashoffset={dashed ? -progress * 40 : 0}
        opacity={0.9}
      />
      {showDot ? <circle cx={dotX} cy={dotY} r={5} fill={color} /> : null}
    </svg>
  )
}
