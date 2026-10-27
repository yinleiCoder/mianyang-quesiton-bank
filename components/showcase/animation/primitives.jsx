// Remotion 场景原语：所有动画由 useCurrentFrame 驱动，不用 CSS keyframes，
// 保证任意跳到某一帧都能确定性重放。
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { SHOWCASE_ICONS } from "@/components/showcase/showcase-icons"
import { toneVideo } from "@/lib/showcase-palette"

export const STAGE = {
  bg: "#f6f6f4",
  fg: "#171717",
  muted: "#6b6b66",
  line: "#d9d9d3",
  card: "#ffffff",
  cardBorder: "#e4e4de",
}

export function StageGrid() {
  return (
    <AbsoluteFill
      style={{
        backgroundImage:
          "linear-gradient(to right, rgba(23,23,23,0.045) 1px, transparent 1px), linear-gradient(to bottom, rgba(23,23,23,0.045) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
      }}
    />
  )
}

export function Icon({ name, size = 28, color }) {
  const Component = SHOWCASE_ICONS[name] ?? SHOWCASE_ICONS.fallback
  return <Component size={size} color={color} strokeWidth={2} />
}

export function BrandMark() {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        border: `1px solid ${STAGE.cardBorder}`,
        background: STAGE.card,
        borderRadius: 999,
        padding: "10px 16px",
        fontSize: 16,
        color: STAGE.muted,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: 999, background: toneVideo("violet") }} />
      职教高考联盟 · 多校共建 · 全市共享
    </div>
  )
}

export function SceneShell({ duration, eyebrow, title, subtitle, footer, children }) {
  const frame = useCurrentFrame()
  // 不从 0 淡入：章节按钮 seek 到场景首帧时若播放被浏览器拦住，
  // 首帧仍应是完整画面，而不是一块空白。只做结尾淡出。
  const opacity = interpolate(
    frame,
    [duration - 12, duration],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  )
  return (
    <AbsoluteFill
      style={{
        opacity,
        padding: "64px 96px 48px",
        display: "flex",
        flexDirection: "column",
        color: STAGE.fg,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24 }}>
        <div>
          <div style={{ fontSize: 18, letterSpacing: 5, color: STAGE.muted, fontWeight: 600 }}>{eyebrow}</div>
          <div style={{ fontSize: 50, fontWeight: 700, lineHeight: 1.15, marginTop: 8 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 21, color: STAGE.muted, marginTop: 8 }}>{subtitle}</div> : null}
        </div>
        <BrandMark />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", marginTop: 24 }}>{children}</div>
      {footer ? (
        <div
          style={{
            marginTop: 16,
            borderTop: `1px solid ${STAGE.line}`,
            paddingTop: 14,
            fontSize: 20,
            color: STAGE.muted,
          }}
        >
          {footer}
        </div>
      ) : null}
    </AbsoluteFill>
  )
}

export function EnterCard({ delay = 0, children, style }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200, mass: 0.6, stiffness: 100 },
  })
  const opacity = interpolate(progress, [0, 1], [0, 1])
  return (
    <div
      style={{
        opacity,
        transform: `translateY(${(1 - progress) * 26}px) scale(${0.98 + progress * 0.02})`,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function Chip({ children, tone = "slate", solid = false }) {
  const color = toneVideo(tone)
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        padding: "5px 10px",
        fontSize: 14,
        fontWeight: 600,
        color: solid ? "#fff" : color,
        background: solid ? color : `${color}14`,
        border: `1px solid ${color}33`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  )
}

export function NodeCard({ icon, title, subtitle, tone = "slate", active = false, badges = [], compact = false, style }) {
  const color = toneVideo(tone)
  return (
    <div
      style={{
        width: "100%",
        boxSizing: "border-box",
        borderRadius: 16,
        border: `1.5px solid ${active ? color : STAGE.cardBorder}`,
        background: STAGE.card,
        padding: compact ? "12px 14px" : "16px 18px",
        boxShadow: active ? `0 10px 30px ${color}26` : "0 4px 14px rgba(23,23,23,0.05)",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: compact ? 32 : 40,
            height: compact ? 32 : 40,
            borderRadius: 12,
            background: `${color}14`,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon name={icon} size={compact ? 18 : 22} color={color} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: compact ? 18 : 21, fontWeight: 700, lineHeight: 1.25 }}>{title}</div>
          <div style={{ fontSize: compact ? 13 : 15, color: STAGE.muted, lineHeight: 1.35, marginTop: 2 }}>{subtitle}</div>
        </div>
      </div>
      {badges.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {badges.map((badge) => <Chip key={badge} tone={tone}>{badge}</Chip>)}
        </div>
      ) : null}
    </div>
  )
}

// 场景内的小节标签（如“客户端 / 入口 / 应用”）。
export function ColumnLabel({ children, color = STAGE.muted }) {
  return (
    <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: 2, color, textTransform: "uppercase" }}>
      {children}
    </div>
  )
}

// 帧驱动的循环进度：用于流动光点。
export function loopT(frame, start, period) {
  const value = (frame - start) / period
  return value - Math.floor(value)
}
