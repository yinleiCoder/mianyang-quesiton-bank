import { withSentryConfig } from "@sentry/nextjs/config"

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  reactCompiler: true,
}

// Sentry 的 source map 上传只在 CI/Vercel 配了 SENTRY_AUTH_TOKEN 时生效；
// 没配时静默跳过，不影响构建。org/project 与 Flutter 端同一个 Sentry 项目。
export default withSentryConfig(nextConfig, {
  org: "yinlei",
  project: "mianyang-quiz",
  silent: true,
  widenClientFileUpload: true,
})
