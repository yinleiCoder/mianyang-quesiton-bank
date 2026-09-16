// 删除 OSS 对象（目前只服务「更换 / 移除头像」后清理旧文件）。
//
// 为什么要有它：全仓库此前没有任何 OSS 删除能力，头像只能越换越多。删除权限绝不能下发到浏览器，
// 只能由服务端持 AccessKey 代签——这与 app/api/oss/sign 的取舍一致。
//
// 三条安全边界：
//   ① 必须登录（Bearer 优先，回落 SSR cookie）；
//   ② key 必须严格匹配 avatars/YYYY/MM/<uuid>.<ext> —— 因此**永远够不到 qbank/ 素材**，
//      题库媒体的生命周期仍归 register_media / GC 管，不受本接口影响；
//   ③ 该 key 不得仍被任何 profiles.avatar_url 引用 —— 防止删掉自己或别人正在用的头像。
//
// 残余风险（明知而接受）：知道自己某个旧头像 key 的登录用户，可以删掉一个**已无人引用**的对象
// （例如别人换掉的旧头像）。实际影响等于零——uuid 路径一次性使用、永不复用，被删对象本就是垃圾；
// 唯一的代价是替别人做了清理。引用校验无法再收紧这一点，要根除只能引入归属台账表，
// 本项目规模不值得。若将来要严格化，方向是「RPC 写台账 + 一次性 claim」。
import { getRequestAuth } from "@/lib/api-auth"
import { ossRequestFromEnv } from "@/lib/oss-sign.mjs"
import { extsFor } from "@/lib/media-spec"

// key 形态由服务端生成（见 sign 路由），这里按同一形状白名单化，不做任何前缀宽松匹配
const AVATAR_KEY_RE = new RegExp(
  `^avatars/\\d{4}/\\d{2}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.(?:${extsFor("avatar").join("|")})$`
)

export async function POST(request) {
  try {
    return await deleteObject(request)
  } catch (err) {
    // 与 sign 路由同款兜底：env 缺失、网络异常等未预期错误也必须回 JSON，
    // 否则客户端（尤其 Flutter 端）拿到 HTML 500，解析错误体时二次崩溃。
    console.error("OSS 删除异常", err)
    return Response.json({ error: "服务端内部错误，请稍后重试" }, { status: 500 })
  }
}

async function deleteObject(request) {
  const { user, supabase } = await getRequestAuth(request)
  if (!user) {
    return Response.json({ error: "未登录或会话已过期" }, { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 })
  }
  // 归一化成字符串后**用它做校验、也用它发请求**——校验一个值却使用另一个值是漏洞的常见来源
  const key = String(body?.key ?? "")
  const match = AVATAR_KEY_RE.exec(key)
  if (!match) {
    return Response.json({ error: "非法的对象路径" }, { status: 400 })
  }
  const uuid = match[1]

  // 引用校验（边界③）。用 uuid 片段而非完整 key 匹配：历史行可能存的是完整 URL 而非相对 key
  // （见 0016 的注释），片段匹配两种形态都能覆盖。uuid 只含 [0-9a-f-]，不含 LIKE 元字符，安全。
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id")
    .ilike("avatar_url", `%${uuid}%`)
    .limit(1)
  if (error) {
    console.error("头像引用校验失败", error)
    return Response.json({ error: "引用校验失败，请稍后重试" }, { status: 500 })
  }
  if (data?.length) {
    return Response.json({ error: "该文件仍在使用，已跳过删除" }, { status: 409 })
  }

  const { url, init } = ossRequestFromEnv({ method: "DELETE", key })
  const res = await fetch(url, init)
  // 幂等：对象已经不在了（重复调用、或之前删过）也算成功
  if (res.status === 404) return Response.json({ ok: true, deleted: false })
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300)
    console.error("OSS 删除失败", res.status, detail)
    return Response.json(
      {
        error:
          res.status === 403
            ? "OSS 拒绝了删除（请确认 RAM 子账号已被授予 oss:DeleteObject）"
            : `OSS 删除失败（HTTP ${res.status}）`,
      },
      { status: 502 }
    )
  }
  return Response.json({ ok: true, deleted: true }, { headers: { "Cache-Control": "no-store" } })
}
