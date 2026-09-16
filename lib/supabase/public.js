// 公共只读数据的 Supabase 客户端：**不绑定任何会话**，因此可以被 unstable_cache 包住。
//
// 为什么要单独一个工厂：lib/supabase/server.js 走 cookies()，而 cookies() 是动态数据源，
// 读了它的函数进不了 Data Cache（见 node_modules/next/dist/docs 缓存指南）。
// 参考数据（科目树、学校名单）与调用者身份无关，用匿名 key 读即可；收口到一处，
// 避免以后有人在缓存函数里顺手写 createClient() 而把整段缓存静默失效。
//
// 边界（务必守住）：
//   · 只能读 RLS 对 anon 开放的表 —— 目前是 schools（0007）与 subject_nodes（0039）。
//     tags 尚未对 anon 授权，读它会得到 permission denied。
//   · 绝不用于写，也绝不用于「代表某个用户」的查询：anon 无身份，auth.uid() 为 null。
//   · 绝不 import next/headers。
import { createClient } from "@supabase/supabase-js"

export function createPublicClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  )
}
