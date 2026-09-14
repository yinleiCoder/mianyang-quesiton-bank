// proxy.ts 请求上下文专用的 Supabase 客户端：读/写都走 request/response cookies
import { NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"

export function createProxyClient(request) {
  let response = null

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          if (response === null) {
            // 首次写入：把 cookies 回灌 request，使本请求后续读取到新会话
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            )
            response = NextResponse.next({ request })
          }
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  return { supabase, getResponse: () => response }
}
