// OSS 签名 v1（Authorization 头形式，HMAC-SHA1）。**服务端专用**——含 node:crypto，
// 绝不能从客户端组件引入。
//
// 签名拼接有个非显然的坑（本仓库已经踩过一次）：
//   CanonicalizedResource 参与签名的形式是 "/<bucket>/<key><?子资源>"，
//   而请求 URL 的路径只能是 "/<key><?子资源>"。
// 把两者当成同一个字符串用，会让桶名重复出现，OSS 直接回 SignatureDoesNotMatch。
//
// 用 .mjs 扩展名：package.json 没有 "type": "module"，.mjs 让 node 无歧义地按 ESM 加载，
// 于是 scripts/ 下的运维脚本与 Next 的 route handler 能共用同一份实现。
import { createHmac } from "crypto"

/**
 * 生成一次 OSS 请求的 URL 与 fetch init。
 * 桶级操作（如 ?cors 看跨域规则）传 key = ""；对象操作传对象的相对 key。
 */
export function ossRequest({
  accessKeyId,
  accessKeySecret,
  bucket,
  endpoint,
  method,
  key = "",
  subresource = "",
  body = "",
  contentType,
  date,
}) {
  const d = date ?? new Date().toUTCString()
  // 无 body 的 GET/DELETE 必须留空的 Content-Type 行——它是签名串的一段，省掉就对不上
  const ct = contentType ?? (body ? "application/xml" : "")
  const canonicalResource = `/${bucket}/${key}${subresource}`
  const stringToSign = [method, "", ct, d, canonicalResource].join("\n")
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64")

  return {
    url: `https://${bucket}.${endpoint}/${key}${subresource}`,
    init: {
      method,
      body: body || undefined,
      headers: {
        Date: d,
        Authorization: `OSS ${accessKeyId}:${signature}`,
        ...(ct ? { "Content-Type": ct } : {}),
      },
    },
  }
}

/** 从 process.env 取凭据的便捷包装；缺失即抛错，由调用方决定怎么呈现给用户。 */
export function ossRequestFromEnv(params) {
  const { OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_ENDPOINT } = process.env
  if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET || !OSS_BUCKET || !OSS_ENDPOINT) {
    throw new Error("服务端未配置 OSS 环境变量")
  }
  return ossRequest({
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET,
    endpoint: OSS_ENDPOINT,
    ...params,
  })
}

/**
 * 生成一条**浏览器可以直接打开**的签名地址（查询串签名，签名版本 1）。
 * 与上面的 ossRequest 是一对：那个给服务端 fetch 用（签名挂在 Authorization 头，Date 参与签名），
 * 这个给人点的链接用（签名挂在 URL 上，Expires 参与签名）——浏览器不会替我们签。
 *
 * 为什么资料下载非用它不可：库里存的对象 key 是 UUID（materials/2026/10/<uuid>.pdf），
 * 直接开公网地址存下来的文件名就是一串 uuid；而 `response-content-disposition` 这类
 * response-* 参数**只在带签名的请求上生效**（OSS 规定），想给它一个像样的文件名，
 * 就只能现场签一条地址。
 *
 * ⚠ [subresources] 的值有**两副面孔**，这是本函数最容易写错的一处（2026-10-12 实测才定下来）：
 *   · URL 里：encodeURIComponent 编码后（`attachment%3B%20filename%3D...`）
 *   · 签名串里：**原文，一个百分号都不加**（`attachment; filename="..."`）
 * 两处都编码（或都不编码）一律得到 SignatureDoesNotMatch，而 OSS 只回一句"签名不匹配"，
 * 不告诉你差在哪个字符——所以这里的两份拼接是刻意分开写的，别"顺手"合并成一个变量。
 * 键按字典序排：CanonicalizedResource 要求如此。
 */
export function ossSignedUrl({
  accessKeyId,
  accessKeySecret,
  bucket,
  endpoint,
  key,
  subresources = {},
  expiresIn = 600,
}) {
  const expires = Math.floor(Date.now() / 1000) + expiresIn
  const pairs = Object.keys(subresources).sort()
  // 签名串用原文（见函数头的两条面孔）
  const canonical = pairs.map((k) => `${k}=${subresources[k]}`).join("&")
  // 查询串签名的第 4 段是 Expires（头签名的第 4 段是 Date），其余与 ossRequest 逐段同形
  const stringToSign = [
    "GET",
    "",
    "",
    expires,
    `/${bucket}/${key}${canonical ? `?${canonical}` : ""}`,
  ].join("\n")
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64")

  const query = pairs.map((k) => `${k}=${encodeURIComponent(subresources[k])}`).join("&")
  const auth = `OSSAccessKeyId=${encodeURIComponent(accessKeyId)}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`
  return `https://${bucket}.${endpoint}/${key}?${query ? `${query}&` : ""}${auth}`
}

/**
 * `Content-Disposition` 头的取值，给**下载**用（配合 ossSignedUrl 的
 * response-content-disposition 子资源）。单独一个函数是因为它有两个必须一起做对的地方：
 *   · 中文名要走 RFC 5987 的 filename*（UTF-8 + 百分号编码）；filename= 只留一份纯 ASCII
 *     兜底——裸中文在个别老浏览器与中间代理那里会变乱码。
 *   · encodeURIComponent 会放过 ! ' ( ) *，而它们不是 RFC 5987 的 attr-char，得补编一次。
 */
export function attachmentHeader(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")
  const utf8 = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

/** ossSignedUrl 的 env 版；缺失凭据即抛错。 */
export function ossSignedUrlFromEnv(params) {
  const { OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_ENDPOINT } = process.env
  if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET || !OSS_BUCKET || !OSS_ENDPOINT) {
    throw new Error("服务端未配置 OSS 环境变量")
  }
  return ossSignedUrl({
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET,
    endpoint: OSS_ENDPOINT,
    ...params,
  })
}
