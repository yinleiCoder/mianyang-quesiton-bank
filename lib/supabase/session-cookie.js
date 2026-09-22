// 会话 cookie 的名字。**必须钉死，不能让它跟着 SUPABASE_URL 走。**
//
// @supabase/ssr 默认按域名第一段算：`sb-<主机名第一段>-auth-token`。实测（本仓库的
// @supabase/ssr 跑出来的真实值）：
//
//   https://jwbczaoevrcrdqqvkfaz.supabase.co  ->  sb-jwbczaoevrcrdqqvkfaz-auth-token
//   https://api.myquiz.cn                     ->  sb-api-auth-token          ← 换域名就会变成这个
//
// 名字一变，浏览器里那份会话就读不到了 —— **所有已登录的老师会在部署瞬间被登出**，
// 而代码看起来完全正常，报错也不会指向这里。我们为了绕开 SNI 拦截把入口换成了
// 反代域名（见仓库根的 supabase-proxy/），所以这里显式钉住旧名字。
//
// ⚠️ 这个值是**换域名之前**那个域名算出来的，**以后不许再改** —— 改了就是又一次全体登出。
//
// 客户端 Flutter 侧是同一个坑，同一套解法，见 mianyang_quiz/lib/bootstrap.dart 的 authOptions。

export const AUTH_COOKIE_NAME = "sb-jwbczaoevrcrdqqvkfaz-auth-token"

// 三个客户端工厂（client / server / proxy）共用，避免各写各的 ——
// 漏掉任何一处，走那条路径的用户就会被登出。
export const SUPABASE_COOKIE_OPTIONS = {
  cookieOptions: { name: AUTH_COOKIE_NAME },
}
