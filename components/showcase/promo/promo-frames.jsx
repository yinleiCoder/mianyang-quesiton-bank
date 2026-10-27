// 设备框与截图叠放：Windows 用桌面窗框，Android 用手机框。
import { useCurrentFrame } from "remotion"
import { PromoImg } from "./promo-image"

export function DesktopFrame({ children, width = 920 }) {
  return (
    <div
      style={{
        width,
        padding: 12,
        borderRadius: 26,
        background: "#14131a",
        boxShadow: "0 38px 90px rgba(30,20,70,0.28), 0 0 0 1px rgba(0,0,0,0.08)",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          overflow: "hidden",
          borderRadius: 16,
          background: "#fff",
        }}
      >
        {children}
      </div>
    </div>
  )
}

export function BrowserFrame({ children, url = "myquiz.cn" }) {
  return (
    <div
      style={{
        width: 920,
        borderRadius: 22,
        overflow: "hidden",
        background: "#f5f4f8",
        border: "1px solid #dedbe8",
        boxShadow: "0 38px 90px rgba(30,20,70,0.22), 0 0 0 1px rgba(0,0,0,0.04)",
      }}
    >
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 16px",
          background: "#eceaf3",
          borderBottom: "1px solid #dedbe8",
        }}
      >
        <span style={{ display: "flex", gap: 6 }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
            <span key={color} style={{ width: 10, height: 10, borderRadius: 999, background: color }} />
          ))}
        </span>
        <div
          style={{
            flex: 1,
            height: 28,
            borderRadius: 999,
            background: "#fff",
            border: "1px solid #e4e1ec",
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
            fontSize: 13,
            color: "#6f6b7a",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          {url}
        </div>
      </div>
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          overflow: "hidden",
          background: "#fff",
        }}
      >
        {children}
      </div>
    </div>
  )
}

export function PhoneFrame({ children }) {
  return (
    <div
      style={{
        position: "relative",
        width: 380,
        height: 820,
        padding: 12,
        borderRadius: 58,
        background: "#14131a",
        boxShadow: "0 38px 90px rgba(30,20,70,0.30), 0 0 0 1px rgba(0,0,0,0.08)",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          borderRadius: 46,
          background: "#fff",
        }}
      >
        {children}
      </div>
      <span
        style={{
          position: "absolute",
          right: -4,
          top: 180,
          width: 4,
          height: 96,
          borderRadius: 4,
          background: "#2a2933",
        }}
      />
    </div>
  )
}

export function PromoImageStack({ images, duration, fit = "cover" }) {
  const frame = useCurrentFrame()
  const current = Math.min(images.length - 1, Math.floor((frame / duration) * images.length))
  const local = (frame / duration) * images.length - current
  return (
    <>
      {images.map((src, index) => (
        <PromoImg
          key={src}
          src={src}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: fit,
            objectPosition: "top center",
            display: "block",
            opacity: index === current ? 1 : 0,
            transform: index === current ? `scale(${1.018 - local * 0.018})` : "scale(1)",
          }}
        />
      ))}
    </>
  )
}
