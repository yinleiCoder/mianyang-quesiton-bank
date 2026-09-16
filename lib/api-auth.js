// Route Handler 的调用者解析：优先 Bearer token（移动/桌面客户端），否则回落 SSR cookie 会话。
// 从 app/api/oss/sign 抽出来供 oss/delete 共用——两处各写一份的话，鉴权口径迟早会分叉。
//
// 为什么不复用 lib/auth.js 的 requireUser / getAuthContext：那里用了 React 的 cache() 与
// redirect()，是给 Server Component 用的；redirect() 在 Route Handler 里是抛异常而非重定向。
//
// 返回的 supabase 客户端**绑定调用者身份**，调用方可直接用它跑 RLS 生效的查询
// （例如「这个 key 还有没有人引用」）——本项目没有、也不应引入 service_role key。
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"

export async function getRequestAuth(request) {
  const auth = request.headers.get("authorization")
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim()
    if (!token) return { user: null, supabase: null }
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    )
    const {
      data: { user },
    } = await supabase.auth.getUser(token)
    return { user: user ?? null, supabase }
  }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { user: user ?? null, supabase }
}
