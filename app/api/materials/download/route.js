// 下载一份复习资料：**服务端签一条地址，再把浏览器 302 过去**。
//
// 为什么不直接把 OSS 公网地址给前端（卡片上「打开」就是这么干的，那条不动）：
//   ① 文件名。对象 key 是 UUID，直接存下来叫 a1b2c3d4-….pdf；带上
//      response-content-disposition 才会存成《资料标题.pdf》——而这个参数**只在带签名的
//      请求上生效**（OSS 规定），签名只能由服务端出。
//   ② 计数。download_count 的语义是"真的存到本地了"（0070 的列注释），走这条路由才有
//      地方给它 +1；直接开公网地址我们一无所知。
//
// 为什么不自己把文件转发一遍（更"正统"的下载代理）：单份资料上限 2GB，从 OSS 拉一遍再吐给
// 浏览器，等于把全市的下载流量都压在 Next 函数上，还白多一跳（OSS 在成都、函数在香港）。
// 302 是让浏览器直连 OSS，服务端只出一条短命签名。
//
// 权限不在这里判，沿用 RLS：查库用的是**调用者身份**的客户端，查不到行就是没权限
//（未发布/已下架的资料只有作者与管理员看得到），与列表页同一把尺子。
import { getRequestAuth } from "@/lib/api-auth"
import { ossSignedUrlFromEnv, attachmentHeader } from "@/lib/oss-sign.mjs"
import { materialFileName } from "@/lib/materials"

// 签名有效期：从点下按钮到浏览器开始下载是一瞬间的事，10 分钟绰绰有余；
// 短一点是为了让这条地址没有转手外传的价值。
const URL_TTL_SECONDS = 10 * 60

export async function GET(request) {
  try {
    return await download(request)
  } catch (err) {
    // 与 sign / delete 两条路由同款兜底：未预期错误也必须回 JSON，而不是 HTML 500
    console.error("资料下载异常", err)
    return Response.json({ error: "服务端内部错误，请稍后重试" }, { status: 500 })
  }
}

async function download(request) {
  const { user, supabase } = await getRequestAuth(request)
  if (!user) {
    return Response.json({ error: "未登录或会话已过期" }, { status: 401 })
  }

  const id = new URL(request.url).searchParams.get("id") ?? ""
  if (!id) {
    return Response.json({ error: "缺少资料 id" }, { status: 400 })
  }

  const { data: row, error } = await supabase
    .from("review_materials")
    .select("id, object_key, title")
    .eq("id", id)
    .maybeSingle()
  if (error) {
    console.error("下载前查询资料失败", error)
    return Response.json({ error: "查询资料失败，请稍后重试" }, { status: 500 })
  }
  if (!row) {
    // 被 RLS 挡下的行与真的不存在在这里是同一个结果——顺带不泄露"有这份资料但你不能看"
    return Response.json({ error: "资料不存在，或已下架" }, { status: 404 })
  }

  // 计数是附带效果：失败只记日志，绝不让"下载"这个动作失败（0070 的 RPC 自己也不抛）
  const { error: countError } = await supabase.rpc("increment_material_download", { p_id: id })
  if (countError) console.error("资料下载计数失败", countError)

  // 签名必须签给桶自己的域名（Host 参与校验），所以这里不用 NEXT_PUBLIC_OSS_PUBLIC_HOST——
  // 当前两者恰好相同，但将来若挂 CDN 就会分叉，那时下载会绕过 CDN 直连 OSS，功能仍然正确。
  const url = ossSignedUrlFromEnv({
    key: row.object_key,
    expiresIn: URL_TTL_SECONDS,
    subresources: {
      // 文件名口径见 lib/materials.js 的 materialFileName（与 Flutter 端同源）
      "response-content-disposition": attachmentHeader(materialFileName(row.title, row.object_key)),
    },
  })

  // no-store：302 不能让中间层留下缓存，否则后面来的人会拿到一条过期的签名地址
  return new Response(null, {
    status: 302,
    headers: { Location: url, "Cache-Control": "no-store" },
  })
}
