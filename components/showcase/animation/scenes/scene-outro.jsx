import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { toneVideo } from "@/lib/showcase-palette"
import { Icon, STAGE } from "../primitives"

const POINTS = [
  { icon: "activity", title: "架构清晰", tone: "violet" },
  { icon: "system_admin", title: "层级明确", tone: "amber" },
  { icon: "published", title: "闭环可查", tone: "emerald" },
]

export function SceneOutro({ duration }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.7 } })
  const opacity = interpolate(
    frame,
    [0, 8, duration - 30, duration],
    [0.85, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  )

  return (
    <AbsoluteFill
      style={{
        opacity,
        color: STAGE.fg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          textAlign: "center",
          transform: `translateY(${(1 - enter) * 18}px) scale(${0.98 + enter * 0.02})`,
        }}
      >
        <div style={{ fontSize: 20, letterSpacing: 8, color: STAGE.muted, fontWeight: 600 }}>
          职教高考联盟
        </div>
        <div style={{ fontSize: 62, fontWeight: 800, marginTop: 14 }}>
          让好题流动起来
        </div>
        <div style={{ display: "flex", gap: 20, justifyContent: "center", marginTop: 40 }}>
          {POINTS.map((point, index) => {
            const color = toneVideo(point.tone)
            return (
              <div
                key={point.title}
                style={{
                  width: 240,
                  borderRadius: 18,
                  border: `1.5px solid ${STAGE.cardBorder}`,
                  background: STAGE.card,
                  padding: "22px 18px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  justifyContent: "center",
                  transform: `translateY(${interpolate(
                    frame,
                    [10 + index * 8, 30 + index * 8],
                    [16, 0],
                    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                  )}px)`,
                }}
              >
                <span
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    background: `${color}14`,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name={point.icon} size={22} color={color} />
                </span>
                <span style={{ fontSize: 24, fontWeight: 700 }}>{point.title}</span>
              </div>
            )
          })}
        </div>
        <div style={{ fontSize: 26, color: STAGE.muted, marginTop: 44 }}>
          myquiz.cn · 多校共建 · 全市共享
        </div>
      </div>
    </AbsoluteFill>
  )
}
