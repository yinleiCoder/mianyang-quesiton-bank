// Supabase 反向代理：把自定义域名上的请求原样转给 Supabase 项目。
//
// 为什么需要它（实测，不是推测）：
//   在国内部分线路上，凡是 TLS ClientHello 里 SNI 带 `supabase.co` 的连接，
//   握手会被直接重置（Dart 报 HandshakeException、curl 报 Recv failure: Connection was reset）。
//   同一台机器、同一个 IP，换个 SNI 就 200 —— 被针对的是**域名**，不是 IP、不是 Cloudflare。
//   手机热点上正常，说明服务端没问题，问题在那条路径上。
//
// 所以这里做的只有一件事：**把主机名换掉**。路径、查询串、请求头、请求体全部原样，
// 客户端（Flutter / 浏览器）看到的是自己的域名，Supabase 看到的是它自己的域名。
//
// 刻意不做的事：
//   · 不做缓存 —— auth 的响应一旦被缓存会串号，这是能造成"登成了别人账号"的那类 bug；
//   · 不做鉴权 —— apikey / Authorization 原样透传，鉴权是 Supabase 的事；
//   · 不挑路径 —— 不做 /auth/v1、/rest/v1 白名单，省不下任何东西，
//     而哪天用上 Storage / Functions 就会莫名其妙 404；
//   · 不接 OSS —— 图片走阿里云成都直连，绕这一趟只会更慢，
//     而且会把 Worker 的免费额度（10 万次/天）拖爆，连登录一起打挂。见 README。
//
// 部署步骤见同目录 README.md。

/** Supabase 项目域名（不含协议）。换项目时只改这一行。 */
const UPSTREAM = 'jwbczaoevrcrdqqvkfaz.supabase.co'

export default {
  async fetch(request) {
    const url = new URL(request.url)
    url.protocol = 'https:'
    url.hostname = UPSTREAM
    url.port = ''

    // new Request(url, request) 会把 method / headers / body 整个照搬。
    // **不要手工复制 body**：Request 的 body 是流，读过一次就没了。
    // Host 头由 URL 决定，所以上游看到的是它自己的域名（Supabase 生成链接时按它算）。
    //
    // **直接把上游的 Response 返回，不要用 new Response(res.body, ...) 重建**：
    // Cloudflare 在 fetch 时已经解过压，重建却会把上游的 `content-encoding: gzip`
    // 原样带回去，而 body 是明文 —— 客户端会解不开，报一堆看不懂的解析错误。
    return fetch(new Request(url, request))
  },
}
