// 软件宣传动画的舞台原语：背景、设备框、截图叠放、文案面板、底部进度。
// 所有动画由 useCurrentFrame 驱动，保证任意跳帧都能确定性重放。
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { toneVideo } from "@/lib/showcase-palette"

export const PROMO_STAGE = {
  bg: "#f7f5ff",
  fg: "#17161f",
  muted: "#6f6b7a",
  line: "#e4e0ef",
  card: "#ffffff",
}

export function PromoBackground() {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: PROMO_STAGE.bg }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 18% 20%, rgba(124,58,237,0.14), transparent 34%), radial-gradient(circle at 84% 78%, rgba(14,165,233,0.12), transparent 36%), linear-gradient(135deg, #f8f6ff 0%, #ffffff 48%, #f1f8ff 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.35,
          backgroundImage:
            "linear-gradient(to right, rgba(23,22,31,0.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(23,22,31,0.035) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />
    </div>
  )
}

export function PromoBrand({ label = "多校共建 · 全市共享" }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 40,
        right: 56,
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        borderRadius: 999,
        border: `1px solid ${PROMO_STAGE.line}`,
        background: "rgba(255,255,255,0.82)",
        color: PROMO_STAGE.muted,
        fontSize: 16,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 9, height: 9, borderRadius: 999, background: toneVideo("violet") }} />
      职教高考联盟 · {label}
    </div>
  )
}

function Bullet({ text, color }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, fontSize: 21, lineHeight: 1.4 }}>
      <span
        style={{
          width: 9,
          height: 9,
          marginTop: 10,
          borderRadius: 999,
          background: color,
          flexShrink: 0,
        }}
      />
      <span>{text}</span>
    </div>
  )
}

export function PromoTextPanel({ chapter, index, total, platform }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const color = toneVideo(chapter.tone)
  const enter = spring({ frame: frame + 8, fps, config: { damping: 200, mass: 0.7 } })
  const opacity = interpolate(enter, [0, 1], [0, 1])

  return (
    <div style={{ width: "100%", opacity, transform: `translateY(${(1 - enter) * 22}px)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderRadius: 999,
            background: `${color}16`,
            color,
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: 1,
          }}
        >
          {platform.label}
        </span>
        <span style={{ fontSize: 16, color: PROMO_STAGE.muted, fontVariantNumeric: "tabular-nums" }}>
          {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
        </span>
      </div>

      <div style={{ marginTop: 26, fontSize: 19, fontWeight: 700, letterSpacing: 4, color }}>
        {chapter.label}
      </div>
      <div style={{ marginTop: 12, fontSize: 54, fontWeight: 800, lineHeight: 1.16 }}>
        {chapter.title}
      </div>
      <div style={{ marginTop: 16, fontSize: 23, lineHeight: 1.5, color: PROMO_STAGE.muted }}>
        {chapter.subtitle}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 13, marginTop: 30 }}>
        {chapter.bullets.map((bullet) => (
          <Bullet key={bullet} text={bullet} color={color} />
        ))}
      </div>
    </div>
  )
}

export function PromoProgress({ platform }) {
  const frame = useCurrentFrame()
  const progress = Math.min(1, frame / platform.durationInFrames)
  const color = toneVideo(platform.accent)

  return (
    <div
      style={{
        position: "absolute",
        left: 96,
        right: 96,
        bottom: 26,
        display: "flex",
        alignItems: "center",
        gap: 18,
        color: PROMO_STAGE.muted,
        fontSize: 14,
      }}
    >
      <span style={{ whiteSpace: "nowrap" }}>使用流程</span>
      <div style={{ position: "relative", flex: 1, height: 4, borderRadius: 999, background: "rgba(23,22,31,0.08)" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${progress * 100}%`,
            borderRadius: 999,
            background: `linear-gradient(90deg, ${toneVideo("violet")}, ${color})`,
          }}
        />
        {platform.chapters.map((chapter) => (
          <span
            key={chapter.id}
            style={{
              position: "absolute",
              left: `${(chapter.from / platform.durationInFrames) * 100}%`,
              top: -3,
              width: 10,
              height: 10,
              borderRadius: 999,
              background: frame >= chapter.from ? color : "rgba(23,22,31,0.18)",
              border: "2px solid #fff",
              transform: "translateX(-50%)",
            }}
          />
        ))}
      </div>
      <span style={{ width: 42, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {Math.round(progress * 100)}%
      </span>
    </div>
  )
}
