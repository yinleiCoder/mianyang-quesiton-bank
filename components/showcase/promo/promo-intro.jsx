import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { PROMO_PLATFORMS } from "@/lib/showcase-promo"
import { toneVideo } from "@/lib/showcase-palette"
import { PromoImg } from "./promo-image"
import { PROMO_STAGE } from "./promo-primitives"

function IntroPreview({ platform }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame: frame + 8, fps, config: { damping: 200, mass: 0.8 } })
  const isWeb = platform.device === "browser"
  const isWindows = platform.device === "desktop"
  const color = toneVideo(platform.accent)
  const width = isWeb || isWindows ? 520 : 210
  const src = isWeb
    ? "showcase/promo/web/ai-import.png"
    : isWindows
      ? "showcase/promo/windows/bank.png"
      : "showcase/promo/android/home.jpg"
  const label = isWeb ? "网页 · 出题" : isWindows ? "Windows" : "Android"

  return (
    <div
      style={{
        position: "relative",
        width,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 34}px) rotate(${isWeb || isWindows ? -3 : 3}deg)`,
      }}
    >
      {isWeb ? (
        <div
          style={{
            borderRadius: 18,
            overflow: "hidden",
            background: "#f5f4f8",
            border: "1px solid #dedbe8",
            boxShadow: `0 30px 70px ${color}33`,
          }}
        >
          <div
            style={{
              height: 34,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 12px",
              background: "#eceaf3",
              borderBottom: "1px solid #dedbe8",
            }}
          >
            <span style={{ display: "flex", gap: 5 }}>
              {["#ff5f57", "#febc2e", "#28c840"].map((dot) => (
                <span key={dot} style={{ width: 7, height: 7, borderRadius: 999, background: dot }} />
              ))}
            </span>
            <div
              style={{
                flex: 1,
                height: 20,
                borderRadius: 999,
                background: "#fff",
                border: "1px solid #e4e1ec",
                display: "flex",
                alignItems: "center",
                padding: "0 8px",
                fontSize: 10,
                color: "#6f6b7a",
                overflow: "hidden",
                whiteSpace: "nowrap",
              }}
            >
              myquiz.cn
            </div>
          </div>
          <div style={{ aspectRatio: "16 / 9", overflow: "hidden", background: "#fff" }}>
            <PromoImg
              src={src}
              style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top center", display: "block" }}
            />
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: isWindows ? 10 : 8,
            borderRadius: isWindows ? 22 : 36,
            background: "#14131a",
            boxShadow: `0 30px 70px ${color}33, 0 0 0 1px rgba(0,0,0,0.08)`,
          }}
        >
          <div
            style={{
              overflow: "hidden",
              borderRadius: isWindows ? 14 : 28,
              background: "#fff",
              aspectRatio: isWindows ? "16 / 9" : "1200 / 2670",
            }}
          >
            <PromoImg
              src={src}
              style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top center", display: "block" }}
            />
          </div>
        </div>
      )}
      <div style={{ marginTop: 14, textAlign: "center", fontSize: 18, fontWeight: 700, color }}>
        {label}
      </div>
    </div>
  )
}

export function PromoIntro({ platform, duration }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const isWeb = platform.id === "web"
  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.7 } })
  const opacity = interpolate(
    frame,
    [0, 10, duration - 12, duration],
    [0.95, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  )

  return (
    <AbsoluteFill
      style={{
        opacity,
        padding: "128px 96px 96px",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
      }}
    >
      <div
        style={{
          transform: `translateY(${(1 - enter) * 22}px) scale(${0.97 + enter * 0.03})`,
        }}
      >
        <div style={{ fontSize: 20, letterSpacing: 10, color: PROMO_STAGE.muted, fontWeight: 700 }}>
          {isWeb ? "职教高考联盟 · 网页教师端" : "职教高考联盟 · 学生端"}
        </div>
        <div style={{ marginTop: 16, fontSize: 72, fontWeight: 800, lineHeight: 1.12 }}>
          {isWeb ? "网页出题，软件刷题" : "同一套题库，两种刷题姿势"}
        </div>
        <div style={{ marginTop: 16, fontSize: 26, color: PROMO_STAGE.muted }}>
          {isWeb
            ? "教师在网页端用 AI 出题、两级审批、组卷；学生在 Windows / Android 刷题、考试、看学情。"
            : "网页出题，软件刷题 · Windows 与 Android 共用一份学情"}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 36, marginTop: 46 }}>
        <IntroPreview platform={isWeb ? PROMO_PLATFORMS.web : PROMO_PLATFORMS.windows} />
        <IntroPreview platform={PROMO_PLATFORMS.android} />
      </div>
    </AbsoluteFill>
  )
}
