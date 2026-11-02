// 浏览器端 Sentry。DSN 走 NEXT_PUBLIC_SENTRY_DSN（publishable，会进包）；
// 未配置时**不初始化**，开发机与没有 DSN 的部署不产生任何上报开销。
import * as Sentry from "@sentry/nextjs"

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    // 与 Flutter 端同一取舍：只要崩溃，不要性能采样。
    tracesSampleRate: 0,
    // 不采集用户身份/IP；错误消息本身按 Sentry 默认策略不脱敏，
    // 业务侧不要把手机号/答案写进异常文本（Flutter 端另有 beforeSend 擦除）。
    sendDefaultPii: false,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
  })
}
