// Next 16：middleware 已更名为 proxy（功能不变，见 node_modules/next/dist/docs）
// 仅做"乐观"会话检查与跳转 —— 不是安全边界：
// 真正鉴权在每个 Server Component 布局 / Server Action / Route Handler 内自查（lib/auth.js）。
import { NextResponse } from "next/server"
import { createProxyClient } from "@/lib/supabase/proxy"

// 无需登录的公开页（均在 (auth) 路由组）
const AUTH_PAGES = ["/login", "/register"]

// 登录后访问的受保护路径前缀（与 (app) 路由组内页面 URL 一致）
const PROTECTED_PREFIXES = ["/dashboard", "/questions", "/review", "/admin", "/bank", "/profile"]

export async function proxy(request) {
  const { supabase, getResponse } = createProxyClient(request)
  const { pathname } = request.nextUrl

  let user = null
  try {
    const { data } = await supabase.auth.getUser()
    user = data.user
  } catch {
    // 网络/解析失败按未登录处理
  }

  const isAuthPage = AUTH_PAGES.includes(pathname)
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  )

  if (user && isAuthPage) {
    return NextResponse.redirect(new URL("/dashboard", request.url))
  }
  if (!user && isProtected) {
    const url = new URL("/login", request.url)
    url.searchParams.set("next", pathname)
    return NextResponse.redirect(url)
  }
  return getResponse() ?? NextResponse.next()
}

export const config = {
  // 跳过静态资源与 favicon
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp3|mp4)$).*)",
  ],
}
