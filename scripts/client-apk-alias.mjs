// 给**已经发布的**那一版补 APK 的 `.bin` 副本，并可把清单里 APK 的 url 指向本站下载路由。
//
// 为什么需要它：2026-10-27 之前发布的版本只把 APK 传成了 `<资产名>.apk`，而阿里云默认域名
// 禁止分发 .apk（三条判据见 app/api/client/download/route.js 的文件头）。下载路由取的是
// `client/dist/<资产名>.bin`。新版本由 `tool/upload_to_oss.mjs` 自动补副本，这个脚本只处理
// 线上已经存在的那一版，以及"网页端还没部署就抢先改清单"的事故恢复。
//
//   node scripts/client-apk-alias.mjs             # 只补 .bin 副本（随时可跑，不影响线上）
//   node scripts/client-apk-alias.mjs --manifest  # 再改清单（**网页端部署之后**才能跑）
//
// `--manifest` 之前会先 HEAD 一次本站下载路由：路由还没上线就拒绝——否则已安装的客户端
// 会从清单里拿到一个 404 的更新地址，比继续走旧线路更糟。
//
// 密钥从 .env.local 读（与 scripts/oss-cors.mjs、服务端路由同一份），不落盘、不外传。
import { readFileSync } from "node:fs"
import { createHmac } from "node:crypto"
import { APK_ALIAS_ASSETS, clientApkAliasKey } from "../lib/client-assets.mjs"

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trimStart().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=")
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)

const {
  OSS_ACCESS_KEY_ID: id,
  OSS_ACCESS_KEY_SECRET: secret,
  OSS_BUCKET: bucket,
  OSS_ENDPOINT: endpoint,
} = env
if (!id || !secret || !bucket || !endpoint) {
  console.error(".env.local 缺少 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_ENDPOINT")
  process.exit(1)
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  const next = i >= 0 ? process.argv[i + 1] : null
  return next && !next.startsWith("--") ? next : fallback
}
const wantsManifest = process.argv.includes("--manifest")
const siteBase = arg("site-base", process.env.CLIENT_SITE_BASE ?? "https://myquiz.cn").replace(/\/+$/, "")

const objectUrl = (key) => `https://${bucket}.${endpoint}/${key}`
const sign = (like) => createHmac("sha1", secret).update(like).digest("base64")

async function headLength(key) {
  const res = await fetch(objectUrl(key), { method: "HEAD" })
  return res.ok ? Number(res.headers.get("content-length") ?? -1) : null
}

/** 服务端整对象复制，并把元数据换成"下载路由能取"的那一套（REPLACE 会清掉旧的头）。 */
async function copyObject(srcKey, destKey) {
  const date = new Date().toUTCString()
  const source = `/${bucket}/${srcKey}`
  // CanonicalizedOSSHeaders：只装 x-oss-*，小写、按字典序、与真正发出去的值逐字一致
  const ossHeaders = [`x-oss-copy-source:${source}`, "x-oss-metadata-directive:REPLACE"].join("\n")
  const stringToSign = ["PUT", "", "application/octet-stream", date, `${ossHeaders}\n/${bucket}/${destKey}`].join("\n")
  const res = await fetch(objectUrl(destKey), {
    method: "PUT",
    headers: {
      Date: date,
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache",
      "x-oss-copy-source": source,
      "x-oss-metadata-directive": "REPLACE",
      Authorization: `OSS ${id}:${sign(stringToSign)}`,
    },
  })
  if (!res.ok) {
    throw new Error(`COPY ${srcKey} → ${destKey} 失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
}

async function putJson(key, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
  const contentType = "application/json"
  const date = new Date().toUTCString()
  const stringToSign = ["PUT", "", contentType, date, `/${bucket}/${key}`].join("\n")
  const res = await fetch(objectUrl(key), {
    method: "PUT",
    body,
    headers: {
      Date: date,
      "Content-Type": contentType,
      // 与发布脚本同一口径：一分钟内让页面与客户端看到新清单
      "Cache-Control": "public, max-age=60",
      Authorization: `OSS ${id}:${sign(stringToSign)}`,
    },
  })
  if (!res.ok) throw new Error(`PUT ${key} 失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
}

const res = await fetch(objectUrl("client/latest.json"), { cache: "no-store" })
if (!res.ok) {
  console.error(`取 client/latest.json 失败：HTTP ${res.status}`)
  process.exit(1)
}
const manifest = await res.json()
const apkAssets = (manifest.assets ?? []).filter((a) => APK_ALIAS_ASSETS.includes(a.name))
if (apkAssets.length === 0) {
  console.error(`清单（${manifest.tag}）里没有可识别的 APK 资产`)
  process.exit(1)
}
console.log(`清单版本 ${manifest.tag}；APK 资产 ${apkAssets.map((a) => a.name).join(", ")}`)

for (const asset of apkAssets) {
  const aliasKey = clientApkAliasKey(asset.name)
  const landed = await headLength(aliasKey)
  if (landed === asset.size) {
    console.log(`= ${aliasKey} 已存在（${landed} 字节），跳过`)
    continue
  }
  console.log(`→ ${asset.name} → ${aliasKey}（${asset.size} 字节）`)
  await copyObject(`client/${asset.name}`, aliasKey)
  const after = await headLength(aliasKey)
  if (after !== asset.size) throw new Error(`${aliasKey} 副本长度对不上：清单 ${asset.size} / OSS ${after}`)
}

if (!wantsManifest) {
  console.log("\n副本已就绪（清单未改）。网页端部署后再跑一次并加 --manifest。")
  process.exit(0)
}

// 先确认路由真的上线了：没上线就改清单，已安装客户端点「去下载」会拿到 404，
// 比继续走旧线路更糟。
const probeName = apkAssets[0].name
const probeUrl = `${siteBase}/api/client/download?name=${encodeURIComponent(probeName)}`
const probe = await fetch(probeUrl, { method: "HEAD" })
if (!probe.ok) {
  console.error(
    `下载路由还没就绪（HEAD ${probeUrl} → ${probe.status}）。先部署网页端，再跑 --manifest；` +
      "只补副本的话不加这个参数。"
  )
  process.exit(1)
}

let changed = 0
for (const asset of apkAssets) {
  const url = `${siteBase}/api/client/download?name=${encodeURIComponent(asset.name)}&v=${encodeURIComponent(manifest.tag)}`
  if (asset.url !== url) {
    asset.url = url
    changed++
  }
}
if (changed === 0) {
  console.log("\n清单里的 APK url 已是最新，无需重写。")
} else {
  await putJson("client/latest.json", manifest)
  console.log(`\n清单已更新：${changed} 个 APK 的 url 指向本站下载路由（${siteBase}）。`)
}
