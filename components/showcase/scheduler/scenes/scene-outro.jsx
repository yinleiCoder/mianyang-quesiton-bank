import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { Chip, STAGE } from "@/components/showcase/primitives"
import { toneVideo } from "@/lib/showcase-palette"

const NUMBERS = [
  { value: "40%", label: "新题保底", tone: "violet" },
  { value: "30%", label: "到期复习配额", tone: "sky" },
  { value: "180 天", label: "最长必再到期", tone: "amber" },
]

export function SceneOutro({ duration }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.7 } })
  const opacity = interpolate(frame, [0, 12, duration - 16, duration], [0.9, 1, 1, 0], {
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
          width: 900,
          height: 900,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${toneVideo("emerald")}14, transparent 65%)`,
        }}
      />
      <div
        style={{
          textAlign: "center",
          transform: `translateY(${(1 - enter) * 18}px) scale(${0.98 + enter * 0.02})`,
        }}
      >
        <div style={{ fontSize: 60, fontWeight: 800, lineHeight: 1.15 }}>
          每一道题，都在对的时间出现
        </div>
        <div style={{ fontSize: 26, color: STAGE.muted, marginTop: 16 }}>
          FSRS 决定「什么时候」，BKT 决定「哪里薄弱」，配额决定「怎么拼」
        </div>
        <div style={{ display: "flex", gap: 26, justifyContent: "center", marginTop: 46 }}>
          {NUMBERS.map((item) => (
            <div
              key={item.label}
              style={{
                width: 220,
                borderRadius: 16,
                border: `1.5px solid ${toneVideo(item.tone)}33`,
                background: "#ffffff",
                padding: "18px 20px",
              }}
            >
              <div style={{ fontSize: 40, fontWeight: 800, color: toneVideo(item.tone) }}>
                {item.value}
              </div>
              <div style={{ fontSize: 16, color: STAGE.muted, marginTop: 4 }}>{item.label}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 40 }}>
          <Chip tone="violet">FSRS-6</Chip>
          <Chip tone="sky">BKT</Chip>
          <Chip tone="emerald">0122 / 0125 / 0126</Chip>
        </div>
      </div>
    </AbsoluteFill>
  )
}
