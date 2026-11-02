"use client"

// 根错误边界：app/(app)/error.jsx 不包同段 layout，layout 自身抛错会落到这里。
// 按 Next 16 约定：必须是客户端组件、自己渲染 <html>/<body>、重试函数叫 retry。
// 它替换整个 root layout，**不继承全局样式**，所以这里只能用内联样式。
import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"

export default function GlobalError({ error, retry }) {
  useEffect(() => {
    // 生产环境 error.message 是通用文案，靠 digest 与服务端日志对照。
    // 未配置 DSN 时 captureException 是 no-op。
    console.error("根布局渲染失败", error)
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="zh-CN">
      <head>
        <title>页面暂时无法加载</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style={{ margin: 0, background: "#fff", color: "#111827" }}>
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily:
              'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          }}
        >
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>
              页面暂时无法加载
            </h1>
            <p
              style={{
                fontSize: 14,
                lineHeight: 1.7,
                color: "#6b7280",
                margin: "0 0 20px",
              }}
            >
              可能是网络波动或服务暂时不可用。请重试一次；若反复失败，请联系系统管理员。
            </p>
            <div
              style={{
                display: "flex",
                gap: 12,
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={() => retry()}
                style={{
                  border: 0,
                  borderRadius: 8,
                  background: "#111827",
                  color: "#fff",
                  fontSize: 14,
                  padding: "10px 18px",
                  cursor: "pointer",
                }}
              >
                重试
              </button>
              <a
                href="/dashboard"
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  color: "#111827",
                  fontSize: 14,
                  padding: "9px 18px",
                  textDecoration: "none",
                }}
              >
                返回工作台
              </a>
            </div>
            {error?.digest && (
              <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 16 }}>
                错误标识：{error.digest}
              </p>
            )}
          </div>
        </main>
      </body>
    </html>
  )
}
