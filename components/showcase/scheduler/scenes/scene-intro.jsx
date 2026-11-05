import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { Chip, STAGE } from "@/components/showcase/primitives"
import { toneVideo } from "@/lib/showcase-palette"

export function SceneIntro({ duration }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.7 } })
  const opacity = interpolate(frame, [0, 10, duration - 14, duration], [0.9, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const line = interpolate(frame, [10, 55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  return (
    <AbsoluteFill
      style={{ opacity, color: STAGE.fg, alignItems: "center", justifyContent: "center" }}
    >
      <div
        style={{
          position: "absolute",
          width: 940,
          height: 940,
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
          科学抽题算法
        </div>
        <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.12, marginTop: 16 }}>
          今天这些题，是怎么选出来的
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
          两道模型：FSRS 管「什么时候复习」，BKT 管「哪里薄弱」
        </div>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 38 }}>
          <Chip tone="violet">FSRS-6 记忆模型</Chip>
          <Chip tone="sky">BKT 知识追踪</Chip>
          <Chip tone="emerald">40 / 30 / 10 配额</Chip>
        </div>
      </div>
    </AbsoluteFill>
  )
}
