// 服务端 Supabase 客户端（Server Components / Server Actions / Route Handlers 用）
// Next 16：cookies() 为 async，故本函数异步。渲染期间写入 cookie 会抛错（try/catch 忽略，
// 会话续期由 proxy.ts 在请求层完成）；Server Action / Route Handler 内可正常写入。
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { SUPABASE_GLOBAL_OPTIONS } from "@/lib/supabase/retry-fetch"
import { SUPABASE_COOKIE_OPTIONS } from "@/lib/supabase/session-cookie"

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      // 连接池超时（PGRST003）自动重试一次；只重试能证明"没执行"的失败，见 retry-fetch.js
      ...SUPABASE_GLOBAL_OPTIONS,
      // 会话 cookie 名钉死：不钉的话，换 SUPABASE_URL 会把所有已登录用户登出，见 session-cookie.js
      ...SUPABASE_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // 在 Server Component 渲染中调用会被拒绝；刷新由 proxy.ts 负责
          }
        },
      },
    }
  )
}
