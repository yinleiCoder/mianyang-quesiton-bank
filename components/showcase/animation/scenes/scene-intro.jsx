import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { Chip, STAGE } from "../primitives"
import { toneVideo } from "@/lib/showcase-palette"

export function SceneIntro({ duration }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.7 } })
  const opacity = interpolate(
    frame,
    [0, 10, duration - 14, duration],
    [0.9, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  )
  const line = interpolate(frame, [10, 55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

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
          position: "absolute",
          width: 920,
          height: 920,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${toneVideo("violet")}14, transparent 65%)`,
        }}
      />
      <div
        style={{
          textAlign: "center",
          transform: `translateY(${(1 - enter) * 20}px) scale(${0.97 + enter * 0.03})`,
        }}
      >
        <div style={{ fontSize: 22, letterSpacing: 10, color: STAGE.muted, fontWeight: 600 }}>
          职教高考联盟
        </div>
        <div style={{ fontSize: 78, fontWeight: 800, lineHeight: 1.12, marginTop: 16 }}>
          软件架构与人员管理
        </div>
        <div
          style={{
            height: 4,
            width: 520 * line,
            margin: "30px auto",
            borderRadius: 999,
            background: `linear-gradient(90deg, ${toneVideo("violet")}, ${toneVideo("emerald")})`,
          }}
        />
        <div style={{ fontSize: 28, color: STAGE.muted }}>
          多校共建 · 全市共享 · 出题到讲评的完整闭环
        </div>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 38 }}>
          <Chip tone="violet">Next.js 16</Chip>
          <Chip tone="sky">Flutter · Windows / Android</Chip>
          <Chip tone="emerald">Supabase</Chip>
        </div>
      </div>
    </AbsoluteFill>
  )
}
