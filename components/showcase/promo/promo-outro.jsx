import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { toneVideo } from "@/lib/showcase-palette"
import { PROMO_STAGE } from "./promo-primitives"

export function PromoOutro({ platform, duration }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.7 } })
  const opacity = interpolate(
    frame,
    [0, 14, duration - 30, duration],
    [0.9, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  )
  const color = toneVideo(platform.accent)

  return (
    <AbsoluteFill
      style={{
        opacity,
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "96px",
      }}
    >
      <div style={{ transform: `translateY(${(1 - enter) * 18}px) scale(${0.98 + enter * 0.02})` }}>
        <div style={{ fontSize: 20, letterSpacing: 8, color: PROMO_STAGE.muted, fontWeight: 700 }}>
          职教高考联盟
        </div>
        <div style={{ marginTop: 16, fontSize: 66, fontWeight: 800 }}>网页出题，软件刷题</div>
        <div style={{ marginTop: 18, fontSize: 26, color: PROMO_STAGE.muted }}>
          教师在 myquiz.cn 出题、审批、组卷；学生在 Windows / Android 刷题、考试、看学情。
        </div>

        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 14,
            marginTop: 38,
            padding: "18px 30px",
            borderRadius: 999,
            border: `1.5px solid ${color}44`,
            background: `${color}12`,
            color,
            fontSize: 26,
            fontWeight: 700,
          }}
        >
          <span style={{ width: 12, height: 12, borderRadius: 999, background: color }} />
          myquiz.cn
        </div>

        <div style={{ marginTop: 16, fontSize: 20, color: PROMO_STAGE.muted }}>
          客户端下载：myquiz.cn/download · Windows 安装包 / Android APK
        </div>

        <div style={{ marginTop: 28, fontSize: 22, color: PROMO_STAGE.muted }}>
          多校共建 · 全市共享 · 让好题流动起来
        </div>
      </div>
    </AbsoluteFill>
  )
}
