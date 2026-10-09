// 本地开发的 DNS 兜底：把 api.myquiz.cn 钉到一个已知可用的 Cloudflare IP。
//
// 什么时候用：`api.myquiz.cn` 的解析**时好时坏**（2026-10-09 实测到一次投毒：解析到
// 103.73.220.77，握手回来一张自签的 `O=redirect-cnzz` 证书；而强制走 104.21.64.10 /
// 172.67.174.21 时返回正常的 401「要 apikey」—— 说明 Worker、证书、链路都没坏，坏的是解析）。
// 症状是"登录页能打开，但登录后又被弹回 /login"（服务端 middleware 连不上 Auth），
// 或者浏览器里 fetch 报 Failed to fetch。
//
// 用法（**必须显式带上，不会自动生效**）：
//   NODE_OPTIONS="--require ./scripts/dev-dns-pin.cjs" npm run dev
// 浏览器侧要同时钉（Chrome 启动参数，注意整串要引号包住，否则 PowerShell 会把空格拆开）：
//   --host-resolver-rules="MAP api.myquiz.cn 104.21.64.10"
//
// 不属于常规开发流程：解析正常时不需要它，DNS 恢复后也应当停用。
// 排障配方见 supabase-proxy/README.md 的「解析被投毒」一节。
const dns = require("node:dns")

const HOST = "api.myquiz.cn"
const PINNED = "104.21.64.10"

// ⚠ 必须处理两参形式 `dns.lookup(host, cb)`：直接把 (options=cb, callback=undefined) 透传给
// 原函数会让它抛 "callback must be a function"，而 dev server 内部就有这种调用 ——
// 症状是 `next dev` 卡在 "Compiling proxy ..." 不动，完全看不出与 DNS 有关。
const origLookup = dns.lookup
dns.lookup = function (hostname, options, callback) {
  if (typeof options === "function") {
    callback = options
    options = {}
  }
  const opts = options || {}
  if (hostname === HOST) {
    if (opts.all) return process.nextTick(() => callback(null, [{ address: PINNED, family: 4 }]))
    return process.nextTick(() => callback(null, PINNED, 4))
  }
  return origLookup.call(dns, hostname, opts, callback)
}

const origResolve4 = dns.resolve4
dns.resolve4 = function (hostname, options, callback) {
  if (typeof options === "function") {
    callback = options
    options = {}
  }
  if (hostname === HOST) return process.nextTick(() => callback(null, [PINNED]))
  return origResolve4.call(dns, hostname, options || {}, callback)
}

if (dns.promises && dns.promises.lookup) {
  const origP = dns.promises.lookup
  dns.promises.lookup = async function (hostname, options) {
    if (hostname === HOST) {
      return options && options.all ? [{ address: PINNED, family: 4 }] : { address: PINNED, family: 4 }
    }
    return origP.call(dns.promises, hostname, options)
  }
}

// ⚠ 这里绝不能往 stdout 写任何东西：NODE_OPTIONS=--require 的脚本会被 npm 自己的启动过程加载，
// 而 npm（shell 包装）靠解析子进程的 stdout 找 Node 安装目录，多一行日志就报
// 「Could not determine Node.js install directory」。要发声只能走 stderr。
if (process.env.DNS_PIN_VERBOSE) process.stderr.write(`[dns-pin] ${HOST} → ${PINNED}\n`)
