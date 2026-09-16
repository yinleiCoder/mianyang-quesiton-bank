// OSS 直传预签名（POST 表单，HMAC-SHA1）：AccessKey 只存在于服务端 .env.local，
// 客户端只能拿到覆盖单次上传的 policy/signature，且对象 key 一律由本路由生成（不信任客户端路径）。
// 用途与上限见 lib/media-spec.js（唯一真源，前端上传器共用同一张表）：
//   · question_media → qbank/…（上传后由客户端调 register_media 登记，随草稿保存挂版本引用，GC 管清理）
//   · avatar        → avatars/…（仅写入 profiles.avatar_url，不登记 media_objects，避免被 GC 误删仍被引用的头像）
// 同一客户端签名复用 OSS 官方 policy 约束：content-length-range / starts-with key / Content-Type 精确匹配。
// 鉴权两种来源：网页端 SSR cookie；Flutter 客户端用 Authorization: Bearer <supabase access_token>（无需 cookie）。
import { createHmac, randomUUID } from "crypto"
import { getRequestAuth } from "@/lib/api-auth"
import { PURPOSES, typeFor, tierFor, tooLargeMessage } from "@/lib/media-spec"

// 签名有效期。1GB 视频按上行 5Mbps 算要约 27 分钟、10Mbps 约 14 分钟，10 分钟的老值必然超时；
// 取 60 分钟覆盖到 4Mbps 并留约 2 倍余量。放宽的代价很小：policy 已绑定精确 key（服务端生成
// 的 uuid 路径）、精确 Content-Type、size range 与 bucket，重放者能做的只是往这条定死的路径写
// 一个符合约束的对象。
const POLICY_TTL_MS = 60 * 60 * 1000

export async function POST(request) {
  try {
    return await signUpload(request)
  } catch (err) {
    // 兜底：env 缺失、Auth 网络失败等未预期异常也必须回 JSON——
    // 否则客户端（尤其 Flutter 端）拿到 HTML 500，解析错误体时二次崩溃。
    console.error("OSS 签名失败", err)
    return Response.json({ error: "服务端内部错误，请稍后重试" }, { status: 500 })
  }
}

async function signUpload(request) {
  const { user } = await getRequestAuth(request)
  if (!user) {
    return Response.json({ error: "未登录或会话已过期" }, { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 })
  }
  const { purpose, contentType, size } = body ?? {}
  const spec = PURPOSES[purpose]
  if (!spec) {
    return Response.json({ error: "未知的用途类型" }, { status: 400 })
  }
  const mime = String(contentType ?? "").toLowerCase()
  const type = typeFor(purpose, mime)
  if (!type) {
    return Response.json({ error: "不支持的文件类型" }, { status: 400 })
  }
  const tier = tierFor(purpose, mime)
  const bytes = Number(size)
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > tier.maxBytes) {
    // 文案与前端 validator 同源（lib/media-spec），保证「提示」与「策略」永远不会各说各话
    return Response.json({ error: tooLargeMessage(purpose, mime) }, { status: 400 })
  }

  const accessKeyId = process.env.OSS_ACCESS_KEY_ID
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET
  const bucket = process.env.OSS_BUCKET
  const endpoint = process.env.OSS_ENDPOINT
  if (!accessKeyId || !accessKeySecret || !bucket || !endpoint) {
    return Response.json({ error: "服务端未配置 OSS 环境变量" }, { status: 500 })
  }

  const now = new Date()
  // <前缀>/YYYY/MM/<uuid>.ext —— 目录按上传月份分片，避免单目录对象过多；uuid 防碰撞防覆盖
  const key = `${spec.keyPrefix}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.${type.ext}`

  const policy = Buffer.from(
    JSON.stringify({
      expiration: new Date(now.getTime() + POLICY_TTL_MS).toISOString(),
      conditions: [
        ["content-length-range", 0, tier.maxBytes],
        { bucket },
        ["starts-with", "$key", spec.keyPrefix],
        ["eq", "$success_action_status", "200"],
        ["eq", "$Content-Type", mime],
      ],
    }),
    "utf8"
  ).toString("base64")
  const signature = createHmac("sha1", accessKeySecret).update(policy).digest("base64")

  // 签名是一次性的，禁止任何中间层缓存
  return Response.json(
    {
      uploadUrl: `https://${bucket}.${endpoint}`,
      bucket,
      fields: {
        key,
        policy,
        OSSAccessKeyId: accessKeyId,
        signature,
        "Content-Type": mime,
        success_action_status: "200",
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
