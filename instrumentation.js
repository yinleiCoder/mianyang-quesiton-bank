// Next 16 的 instrumentation 入口：按运行时加载对应 Sentry 配置，
// 并把请求级错误接到 Sentry（onRequestError）。
import * as Sentry from "@sentry/nextjs"

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config")
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }
}

export const onRequestError = Sentry.captureRequestError
