// 浏览器端 Supabase 客户端（@supabase/ssr：会话读写 cookie）
import { createBrowserClient } from "@supabase/ssr"
import { SUPABASE_GLOBAL_OPTIONS } from "@/lib/supabase/retry-fetch"

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    // 连接池超时（PGRST003）自动重试；浏览器侧最需要它 —— 跑批时那一次 504
    // 会直接中止整条流水线。只重试能证明"没执行"的失败，见 retry-fetch.js
    SUPABASE_GLOBAL_OPTIONS
  )
}
