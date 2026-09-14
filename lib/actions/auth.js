// 鉴权类 Server Actions。注意：Server Action 调用不经过根 proxy.ts 的路径守卫，
// 所以每个 action 都要自行完成鉴权与授权校验。
"use server"

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/login")
}
