// PostgREST 连接池超时的自动重试（PGRST003 / HTTP 504）。
//
// 为什么**只**重试这一种错误：它是唯一能证明「请求根本没执行」的失败。
// PGRST003 由 PostgREST 在**拿到数据库连接之前**返回（池子满了、等待超时），语句压根没跑；
// 所以重试对写操作也安全 —— 不会把一次提交做成两次。
//
// 反过来，网络层报错（fetch 直接抛）是**语义不明**的：请求可能已经执行、只是回包没到，
// 重试就可能重复写入。那类一律不重试 —— 宁可让使用者看到错误，也不能冒重复写的风险。
// 这正是本文件不敢写成「通用重试中间件」的原因。
//
// 代价要如实说：PostgREST 的池等待超时约 60 秒，所以第一次拿到 504 时，用户已经等了 60 秒。
// 重试是"再等一次"，不是"立刻恢复"。因此次数很少（最多 2 次），且延迟很短 ——
// 池子一旦腾出来，紧接着的请求就能进。
//
// 这个文件是**兜底**，不是解法。真正的解法是降低并发占用：一个页面渲染打的并发查询越少，
// 撞上池满的概率越低（见 app/(app)/bank/page.jsx 里把学校名单改用缓存那处）。

const RETRYABLE_CODE = "PGRST003"
// **只重试 1 次**，而且不要再多了：每次重试都可能再等一个完整的池超时（约 60 秒），
// 试 3 次就是 3 分钟的白屏 —— 那比直接报错还糟。
//
// 还要看清一件事：PGRST003 意味着池子在**整个等待窗口里一直是满的**（不是"刚好撞上一下"），
// 所以重试的收益其实有限，它的价值在于把"必然失败"变成"可能成功"，而不是"立刻恢复"。
// 想要变快只能靠减少并发占用（那才是根治），这里只是别让一次拥塞直接变成一页 500。
const MAX_RETRIES = 1
// 等一小会儿再试：池子若是刚被释放，紧接着的请求就能进。
const DELAYS_MS = [400]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 只有当响应确实是 PostgREST 的连接池超时才算数：504 之外的状态码、或响应体不是预期的
// JSON 形状，都按普通错误原样交给调用方。读体用 clone()，不消耗真正要交给 supabase-js 的那份。
async function isPoolTimeout(res) {
  if (res.status !== 504) return false
  try {
    const body = await res.clone().json()
    return body?.code === RETRYABLE_CODE
  } catch {
    return false
  }
}

// 请求体若是流（一次性可读），重放会失败，直接放弃重试。
function bodyIsReplayable(init) {
  const body = init?.body
  if (body == null) return true
  if (typeof body === "string") return true
  return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
}

export function createRetryingFetch(baseFetch = globalThis.fetch) {
  return async function retryingFetch(input, init) {
    let res = await baseFetch(input, init)
    if (!bodyIsReplayable(init)) return res

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (!(await isPoolTimeout(res))) return res
      await sleep(DELAYS_MS[attempt] ?? DELAYS_MS[DELAYS_MS.length - 1])
      res = await baseFetch(input, init)
    }
    return res
  }
}

// 三个客户端工厂共用的 options，避免各写各的（漏一个就等于那条路径没有兜底）。
export const SUPABASE_GLOBAL_OPTIONS = {
  global: { fetch: createRetryingFetch() },
}
