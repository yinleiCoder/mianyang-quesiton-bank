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
