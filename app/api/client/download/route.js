// **过渡期的兼容入口**：302 到 `/download/apk` 自动下载页。
//
// 2026-10-27 这里曾经是"从 OSS 取回字节、在本站域名下补文件名"的转发路由，
// 2026-10-29 实测**不可用**：Vercel 香港函数连不上成都 OSS（连接稳定地在 10 秒后
// 超时，构建环境却能连），对任何人都是 502。现在下载改由浏览器直连 OSS 完成，
// 见 components/download/apk-download.jsx。
//
// 为什么还留着这条路由：**线上清单里的 APK url 还指着它**（v2.9.2 就是）。
// 用 302 把老客户端送到落地页，部署完立即生效，不需要先改清单；等
// `scripts/client-apk-alias.mjs --manifest` 把清单回填之后，就只剩收藏/外传的旧链接
// 还会来这里。302 不碰 OSS，所以它在这台函数上也能正常工作。
import { APK_ALIAS_ASSETS } from "@/lib/client-assets.mjs"

export async function GET(request) {
  const url = new URL(request.url)
  const name = url.searchParams.get("name") ?? ""
  if (!APK_ALIAS_ASSETS.includes(name)) {
    return new Response("未知的安装包", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    })
  }

  const target = new URL("/download/apk", url.origin)
  target.searchParams.set("name", name)
  const version = url.searchParams.get("v")
  if (version) target.searchParams.set("v", version)

  // no-store：签名/参数都不该被中间层留下缓存
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), "Cache-Control": "no-store" },
  })
}

export async function HEAD(request) {
  return GET(request)
}
