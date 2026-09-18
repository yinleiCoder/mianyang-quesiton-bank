// retry-fetch 的边界自检：npm run test:retry。
//
// 为什么值得留一个测试：这里的安全论证是**单向**的 —— "只重试能证明没执行过的失败"。
// 哪天有人图省事把网络异常也加进重试列表，就可能把一次写操作做成两次，而那种 bug
// 在测试环境几乎不会自己暴露。这几条断言就是那道闸。
import { createRetryingFetch } from "@/lib/supabase/retry-fetch"

let pass = 0
let fail = 0
const ok = (c, name, extra) => {
  if (c) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? " → " + JSON.stringify(extra) : ""}`) }
}

const body504 = JSON.stringify({ code: "PGRST003", message: "Timed out acquiring connection from connection pool." })
const resp = (status, body) => new Response(body, { status, headers: { "content-type": "application/json" } })
const req = (init = {}) => ["https://x.supabase.co/rest/v1/rpc/f", init]

console.log("\n【1】连接池超时 → 重试一次后成功")
{
  let n = 0
  const f = createRetryingFetch(async () => (++n === 1 ? resp(504, body504) : resp(200, '{"ok":true}')))
  const r = await f(...req({ method: "POST", body: "{}" }))
  ok(r.status === 200 && n === 2, "第一次 504、第二次 200", { status: r.status, calls: n })
}

console.log("\n【2】一直 504 → 只重试 1 次就放弃（不能无限拖）")
{
  let n = 0
  const f = createRetryingFetch(async () => { n++; return resp(504, body504) })
  const r = await f(...req())
  ok(n === 2, "总共只发 2 次", { calls: n })
  ok(r.status === 504, "把最后一次失败原样交给调用方")
}

console.log("\n【3】非 PGRST003 的 504 → 不重试（无法证明语句没执行）")
{
  let n = 0
  const f = createRetryingFetch(async () => { n++; return resp(504, '{"code":"57014","message":"statement timeout"}') })
  await f(...req())
  ok(n === 1, "不重试", { calls: n })
}

console.log("\n【4】网络层抛异常 → 不重试（写操作可能已执行，重试会重复写入）")
{
  let n = 0
  const f = createRetryingFetch(async () => { n++; throw new Error("fetch failed") })
  let threw = false
  try { await f(...req({ method: "POST", body: "{}" })) } catch { threw = true }
  ok(threw && n === 1, "原样抛出且只发 1 次", { calls: n })
}

console.log("\n【5】请求体是流 → 不重试（无法重放）")
{
  let n = 0
  const f = createRetryingFetch(async () => { n++; return resp(504, body504) })
  const stream = new ReadableStream()
  await f(...req({ method: "POST", body: stream }))
  ok(n === 1, "不重试", { calls: n })
}

console.log("\n【6】正常响应 → 原样返回，不重试")
{
  let n = 0
  const f = createRetryingFetch(async () => { n++; return resp(200, '{"ok":true}') })
  const r = await f(...req())
  ok(r.status === 200 && n === 1, "只发 1 次", { calls: n })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
