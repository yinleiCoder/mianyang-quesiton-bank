// Android 安装包的下载出口：**在本站域名下转发 OSS 的字节**。
//
// 为什么不能直连 OSS：阿里云默认域名（*.aliyuncs.com）禁止分发 APK。2026-10-27 逐条实测，
// 下面三条命中任意一条就回 400 ApkDownloadForbidden——带签名的地址一样挡：
//   ① 对象 key 以 .apk 结尾；
//   ② 响应的 Content-Type 是 application/vnd.android.package-archive；
//   ③ Content-Disposition 里的文件名以 .apk 结尾。
// 绑定自定义域名要求大陆 ICP 备案，`myquiz.cn` 目前没有，这条路短期走不通。
//
// 解法：发布流水线给每个 APK 在桶里**另存一份** `client/dist/<资产名>.bin`
//（application/octet-stream、不带 Content-Disposition，三条都不命中），
// 这条路由把字节取回来，在**本站域名**下补上正确的 Content-Type 与文件名。
// 浏览器与客户端拿到的就是一份可安装的 .apk。
//
// 为什么这里转发字节，而不像资料下载（/api/materials/download）那样 302：
// 302 的终点仍然是 OSS 默认域名，文件名与类型一样过不了上面那道闸。APK 单份约 30MB
//（资料上限 2GB），多一跳可以接受；URL 带 `?v=<tag>`，同版本允许 CDN 缓存、只回源一次。
//
// **只放行 lib/client-assets.js 里的三个资产名**：这是一条公开路由，
// 不做白名单就等于把整只桶变成了任何人可用的免费出口。
import { APK_ALIAS_ASSETS, clientApkAliasKey } from "@/lib/client-assets.mjs"
import { attachmentHeader } from "@/lib/oss-sign.mjs"

const APK_CONTENT_TYPE = "application/vnd.android.package-archive"

export async function GET(request) {
  return serve(request, "GET")
}

// HEAD 也显式处理：下载管理器/浏览器取文件名与长度时不必拉 30MB 字节。
export async function HEAD(request) {
  return serve(request, "HEAD")
}

async function serve(request, method) {
  const name = new URL(request.url).searchParams.get("name") ?? ""
  if (!APK_ALIAS_ASSETS.includes(name)) {
    return text("未知的安装包", 404)
  }

  const bucket = process.env.OSS_BUCKET
  const endpoint = process.env.OSS_ENDPOINT
  if (!bucket || !endpoint) {
    console.error("[client-download] 缺少 OSS_BUCKET / OSS_ENDPOINT")
    return text("下载服务未配置，请稍后再试", 500)
  }

  // Range 透传：断点续传与下载管理器会带它，OSS 原样回 206。
  const range = request.headers.get("range")
  let upstream
  try {
    upstream = await fetch(`https://${bucket}.${endpoint}/${clientApkAliasKey(name)}`, {
      method,
      cache: "no-store",
      headers: range ? { Range: range } : undefined,
    })
  } catch (err) {
    console.error("[client-download] 取 OSS 失败", err)
    return text("下载服务暂时不可用，请稍后再试", 502)
  }

  if (!upstream.ok) {
    console.error(`[client-download] OSS 响应 ${upstream.status}（${name}）`)
    // 404 多半是这一版还没把 .bin 副本传上去（旧版本或上传只完成一半）
    return text(
      upstream.status === 404 ? "这个安装包还没有同步完成，请稍后再试" : "下载服务暂时不可用，请稍后再试",
      upstream.status === 404 ? 404 : 502
    )
  }

  const headers = new Headers({
    "Content-Type": APK_CONTENT_TYPE,
    "Content-Disposition": attachmentHeader(name),
    "Accept-Ranges": "bytes",
    // 206 不缓存（部分内容互相覆盖没有意义）；整份响应按 ?v=<tag> 缓存一天。
    "Cache-Control": upstream.status === 206 ? "no-store" : "public, max-age=0, s-maxage=86400",
  })
  // 长度与区间来自 OSS，别自己算（HEAD 与 206 的语义都靠这两个头）
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h)
    if (v) headers.set(h, v)
  }

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  })
}

function text(message, status) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  })
}
