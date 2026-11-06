// 只读压测：模拟 N 个并发用户反复调用首页/名册会打的**只读 RPC**。
//
// 为什么单独写一个：要判断"上千人能不能撑住"，只有实测并发曲线才算数；
// 而这个脚本刻意**不写任何数据**（不碰 start_exam_attempt / submit_* / 任何 insert），
// 所以可以随时对线上跑，只消耗读路径的 CPU 和连接。
//
// 用法（npm 脚本已经带上 --env-file=.env.local）：
//   LOADTEST_EMAIL='13800138000@phone.myquiz.cn' LOADTEST_PASSWORD='…' \
//     npm run test:load -- --users=50 --seconds=30
//
// 或者直接给一个已登录的 access token（从浏览器 localStorage 里取）：
//   LOADTEST_ACCESS_TOKEN='eyJ…' npm run test:load -- --users=200 --seconds=60
//
// 参数：
//   --users=50        并发虚拟用户数（默认 20）
//   --seconds=30      持续秒数（默认 30）
//   --rpc=a,b         要打的 RPC，逗号分隔（默认 practice_dashboard,auth_context）
//
// ⚠ N 个虚拟用户**共用同一个账号**：测的是服务端并发能力，不是"多人各自数据"
//   的正确性；连接数、CPU、57014 比这个脚本报出的延迟更重要。

import process from "node:process"

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const EMAIL = process.env.LOADTEST_EMAIL
const PASSWORD = process.env.LOADTEST_PASSWORD
let TOKEN = process.env.LOADTEST_ACCESS_TOKEN || ""

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.replace(/^--/, "").split("=")
    return [k, v ?? "true"]
  })
)
const USERS = Math.max(1, Number(args.users) || 20)
const SECONDS = Math.max(1, Number(args.seconds) || 30)
const RPCS = String(args.rpc || "practice_dashboard,auth_context")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

if (!BASE || !ANON) {
  console.error("缺 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY（--env-file=.env.local）")
  process.exit(1)
}

async function signIn() {
  if (TOKEN) return TOKEN
  if (!EMAIL || !PASSWORD) {
    console.error(
      "需要一个测试账号：LOADTEST_EMAIL + LOADTEST_PASSWORD，或直接给 LOADTEST_ACCESS_TOKEN。\n" +
        "手机号账号的邮箱是合成地址，形如 13800138000@phone.myquiz.cn。"
    )
    process.exit(1)
  }
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.access_token) {
    console.error(`登录失败（${res.status}）：${json.error_description || json.msg || "未知原因"}`)
    process.exit(1)
  }
  return json.access_token
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}

async function callRpc(rpc, token) {
  const started = performance.now()
  let status = 0
  let code = ""
  try {
    const res = await fetch(`${BASE}/rest/v1/rpc/${rpc}`, {
      method: "POST",
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    })
    status = res.status
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      code = body.code || ""
    } else {
      await res.arrayBuffer() // 把响应体读完，才算一次完整请求
    }
  } catch {
    status = -1 // 网络层失败
  }
  return { ms: performance.now() - started, status, code }
}

const token = await signIn()
console.log(
  `\n压测：${USERS} 并发 × ${SECONDS}s → ${RPCS.join(" / ")}\n` +
    `目标：${BASE}（**线上库**，只读；不写数据）\n`
)

const latencies = []
const statuses = new Map()
const codes = new Map()
const deadline = Date.now() + SECONDS * 1000
const startedAt = Date.now()

async function worker(index) {
  let n = 0
  while (Date.now() < deadline) {
    const rpc = RPCS[(index + n) % RPCS.length]
    const { ms, status, code } = await callRpc(rpc, token)
    latencies.push(ms)
    statuses.set(status, (statuses.get(status) || 0) + 1)
    if (code) codes.set(code, (codes.get(code) || 0) + 1)
    n += 1
  }
}

await Promise.all(Array.from({ length: USERS }, (_, i) => worker(i)))

const elapsed = (Date.now() - startedAt) / 1000
const sorted = [...latencies].sort((a, b) => a - b)
const total = sorted.length

console.log(`总请求 ${total}，用时 ${elapsed.toFixed(1)}s，吞吐 ${(total / elapsed).toFixed(1)} req/s`)
console.log(
  `延迟  p50 ${pct(sorted, 50).toFixed(0)}ms · p90 ${pct(sorted, 90).toFixed(0)}ms · ` +
    `p99 ${pct(sorted, 99).toFixed(0)}ms · max ${sorted[total - 1]?.toFixed(0) ?? 0}ms`
)
console.log(
  `状态  ${[...statuses.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s === -1 ? "网络失败" : s}: ${n}`)
    .join(" · ")}`
)
if (codes.size > 0) {
  console.log(`SQLSTATE  ${[...codes.entries()].map(([c, n]) => `${c}: ${n}`).join(" · ")}`)
}
console.log(
  "\n看三个数：① p99 是否接近 8s（statement_timeout，57014 一出现就是这个）" +
    "② 57014/5xx 是否出现 ③ 吞吐是否随并发线性增长（不涨=连接或 CPU 排队）\n"
)
