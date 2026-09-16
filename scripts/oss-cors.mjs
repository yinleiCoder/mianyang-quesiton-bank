// OSS 桶跨域规则（CORS）读写工具。
//
// 为什么需要它：网页端是「浏览器直传 OSS」（见 lib/upload.js），跨域请求受桶的 CORS 规则约束。
// 换域名（本地 → Vercel → 正式域名）后若不更新白名单，上传会以 "Failed to fetch" 失败，
// 而报错点离真正原因很远——所以把这件事做成一条可重复执行的命令。
//
//   node scripts/oss-cors.mjs show                    # 查看当前规则
//   node scripts/oss-cors.mjs set https://a.com https://b.com
//   node scripts/oss-cors.mjs add https://a.com       # 追加来源到现有规则
//
// 密钥从 .env.local 读（与服务端路由同一份），不落盘、不外传。
import { readFileSync } from "fs"
import { ossRequest } from "../lib/oss-sign.mjs"

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trimStart().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=")
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)

const { OSS_ACCESS_KEY_ID: id, OSS_ACCESS_KEY_SECRET: secret, OSS_BUCKET: bucket, OSS_ENDPOINT: endpoint } = env
if (!id || !secret || !bucket || !endpoint) {
  console.error(".env.local 缺少 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_ENDPOINT")
  process.exit(1)
}

// 签名实现抽到 lib/oss-sign.mjs，与 app/api/oss/delete 路由共用一份——
// 那段拼接有个已踩过的坑（桶级操作的 CanonicalizedResource 与 URL 路径不同），
// 复制一份基本注定复发。
function ossFetch(method, key, subresource, body = "") {
  const { url, init } = ossRequest({
    accessKeyId: id,
    accessKeySecret: secret,
    bucket,
    endpoint,
    method,
    key,
    subresource,
    body,
  })
  return fetch(url, init)
}

const rules = (origins) => `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
${origins.map((o) => `    <AllowedOrigin>${o}</AllowedOrigin>`).join("\n")}
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>DELETE</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-oss-request-id</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`

const parseOrigins = (xml) => [...xml.matchAll(/<AllowedOrigin>([^<]+)<\/AllowedOrigin>/g)].map((m) => m[1])

const [cmd, ...args] = process.argv.slice(2)

if (cmd === "show" || !cmd) {
  const res = await ossFetch("GET", "", "?cors")
  console.log("HTTP", res.status)
  const text = await res.text()
  console.log(text)
  if (res.ok) console.log("当前放行来源：", parseOrigins(text).join("  "))
  process.exit(res.ok ? 0 : 1)
}

if (cmd === "set" || cmd === "add") {
  let origins = args
  if (cmd === "add") {
    const cur = await ossFetch("GET", "", "?cors")
    if (!cur.ok) {
      console.error("读取现有规则失败（HTTP " + cur.status + "），请先核对密钥权限：\n" + (await cur.text()))
      process.exit(1)
    }
    origins = [...new Set([...parseOrigins(await cur.text()), ...args])]
  }
  if (origins.length === 0) {
    console.error("至少要给一个来源，例如：node scripts/oss-cors.mjs set https://example.vercel.app")
    process.exit(1)
  }
  const res = await ossFetch("PUT", "", "?cors", rules(origins))
  console.log("HTTP", res.status)
  const text = await res.text()
  if (text.trim()) console.log(text)
  if (res.ok) console.log("已写入放行来源：", origins.join("  "))
  process.exit(res.ok ? 0 : 1)
}

console.error("用法：node scripts/oss-cors.mjs show | set <origin...> | add <origin...>")
process.exit(1)
