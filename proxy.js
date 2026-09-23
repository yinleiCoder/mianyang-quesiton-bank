// Next 16：middleware 已更名为 proxy（功能不变，见 node_modules/next/dist/docs）
// 仅做"乐观"会话检查与跳转 —— 不是安全边界：
// 真正鉴权在每个 Server Component 布局 / Server Action / Route Handler 内自查（lib/auth.js）。
//
// 用 getClaims() 而不是 getUser()：本项目 JWT 是 ES256 非对称签名
//（auth/v1/.well-known/jwks.json 实测为 EC P-256 且带 kid），getClaims 用本地 JWKS 验签，
// 不再每个请求打一次 /auth/v1/user（实测 172 次/24h、均值 282ms、峰值 1084ms）。
// 换成 HS256 签发时 SDK 会自动退回 getUser()，即最坏情况也只是回到今天的行为。
//
// 副作用与 getUser() 一致：access token 临近过期时，getClaims → getSession →
// __loadSession 仍会 _callRefreshToken，并经 setAll 写回 cookie。**这里是唯一能写 cookie
// 的地方**——Server Component 渲染期写 cookie 会被 Next 拒绝并静默吞掉（见 lib/supabase/server.js）。
// 因此 matcher 不可收窄到只覆盖受保护路径（也不要跳过 prefetch）：任何可导航路径漏掉 proxy，
// 渲染期发生的令牌刷新就无处落盘，refresh token 轮换不同步，表现为用户被静默登出。
import { NextResponse } from "next/server"
import { createProxyClient } from "@/lib/supabase/proxy"

// 无需登录的公开页（均在 (auth) 路由组）
// /reset-password 必须在列：忘记密码的人**恰恰是登不上的那批人**，漏登记就会被挡回登录页
const AUTH_PAGES = ["/login", "/register", "/reset-password"]

// 登录后访问的受保护路径前缀（与 (app) 路由组内页面 URL 一致）
const PROTECTED_PREFIXES = ["/dashboard", "/questions", "/review", "/admin", "/bank", "/papers", "/materials", "/profile", "/students"]

export async function proxy(request) {
  const { supabase, getResponse } = createProxyClient(request)
  const { pathname } = request.nextUrl

  let user = null
  try {
    const { data } = await supabase.auth.getClaims()
    if (data?.claims?.sub) user = { id: data.claims.sub }
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
  // 跳过静态资源与 favicon。**不要再加别的排除项**（尤其是带 missing: next-router-prefetch
  // 的预取排除写法）：理由见文件顶部——cookie 只能在这里写，漏掉就会丢刷新。
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp3|mp4)$).*)",
  ],
}
