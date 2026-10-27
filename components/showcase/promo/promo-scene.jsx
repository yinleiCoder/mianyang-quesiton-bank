import { spring, useCurrentFrame, useVideoConfig } from "remotion"
import { toneVideo } from "@/lib/showcase-palette"
import { BrowserFrame, DesktopFrame, PhoneFrame, PromoImageStack } from "./promo-frames"
import { PromoTextPanel } from "./promo-primitives"

export function PromoScene({ chapter, platform, index, total }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const color = toneVideo(chapter.tone)
  const reverse = index % 2 === 1
  const enter = spring({
    // +8：章节按钮 seek 到首帧时，即使播放被浏览器拦住也先露出一部分画面
    frame: frame + 8,
    fps,
    config: { damping: 200, mass: 0.8, stiffness: 90 },
  })
  const textWidth = platform.device === "phone" ? 840 : 660

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        padding: "110px 96px 92px",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 66,
          [reverse ? "right" : "left"]: 60,
          fontSize: 300,
          lineHeight: 1,
          fontWeight: 900,
          color,
          opacity: 0.045,
          letterSpacing: -12,
          pointerEvents: "none",
        }}
      >
        {String(index + 1).padStart(2, "0")}
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: platform.device === "phone" ? 64 : 56,
          height: "100%",
          flexDirection: reverse ? "row-reverse" : "row",
        }}
      >
        <div style={{ width: textWidth, flexShrink: 0 }}>
          <PromoTextPanel chapter={chapter} index={index} total={total} platform={platform} />
        </div>

        <div
          style={{
            position: "relative",
            flexShrink: 0,
            opacity: enter,
            transform: `translateX(${(1 - enter) * (reverse ? -38 : 38)}px) scale(${0.96 + enter * 0.04})`,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: platform.device === "phone" ? 4 : 10,
              width: platform.device === "phone" ? 320 : 760,
              height: 26,
              borderRadius: "50%",
              background: "rgba(30,20,70,0.14)",
              filter: "blur(16px)",
              transform: "translateX(-50%)",
            }}
          />
          {platform.device === "phone" ? (
            <PhoneFrame>
              <PromoImageStack images={chapter.images} duration={chapter.duration} />
            </PhoneFrame>
          ) : platform.device === "browser" ? (
            <BrowserFrame url={chapter.url}>
              <PromoImageStack images={chapter.images} duration={chapter.duration} />
            </BrowserFrame>
          ) : (
            <DesktopFrame>
              <PromoImageStack images={chapter.images} duration={chapter.duration} />
            </DesktopFrame>
          )}
        </div>
      </div>
    </div>
  )
}
