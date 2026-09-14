// OSS 直传预签名（POST 表单，HMAC-SHA1）：AccessKey 只存在于服务端 .env.local，
// 客户端只能拿到覆盖单次上传的 policy/signature，且对象 key 一律由本路由生成（不信任客户端路径）。
// 用途白名单：
//   · question_media → qbank/…（上传后由客户端调 register_media 登记，随草稿保存挂版本引用，GC 管清理）
//   · avatar        → avatars/…（仅写入 profiles.avatar_url，不登记 media_objects，避免被 GC 误删仍被引用的头像）
// 同一客户端签名复用 OSS 官方 policy 约束：content-length-range / starts-with key / Content-Type 精确匹配。
// 鉴权两种来源：网页端 SSR cookie；Flutter 客户端用 Authorization: Bearer <supabase access_token>（无需 cookie）。
import { createHmac, randomUUID } from "crypto"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"

// 解析调用者：优先 Bearer token（移动/桌面客户端），否则回落到 SSR cookie 会话
async function getRequestUser(request) {
  const auth = request.headers.get("authorization")
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim()
    if (!token) return null
    const client = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    )
    const {
      data: { user },
    } = await client.auth.getUser(token)
    return user ?? null
  }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user ?? null
}

const PURPOSES = {
  question_media: {
    keyPrefix: "qbank/",
    maxBytes: 50 * 1024 * 1024, // 图片/音视频/文件附件
    // 白名单须与前端上传器 accept 表保持一致（另见 EXT_BY_MIME）
    mimeRe: /^(image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg)|video\/(?:mp4|webm)|application\/(?:pdf|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.openxmlformats-officedocument\.presentationml\.presentation)|text\/(?:plain|markdown|csv))$/,
  },
  avatar: {
    keyPrefix: "avatars/",
    maxBytes: 5 * 1024 * 1024,
    mimeRe: /^image\/(?:png|jpeg|webp)$/,
  },
}

const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
}

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
  const user = await getRequestUser(request)
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
  const cfg = PURPOSES[purpose]
  if (!cfg) {
    return Response.json({ error: "未知的用途类型" }, { status: 400 })
  }
  const mime = String(contentType ?? "").toLowerCase()
  if (!cfg.mimeRe.test(mime)) {
    return Response.json({ error: "不支持的文件类型" }, { status: 400 })
  }
  const bytes = Number(size)
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > cfg.maxBytes) {
    return Response.json(
      { error: `文件大小需在 1B ~ ${Math.floor(cfg.maxBytes / 1024 / 1024)}MB 之间` },
      { status: 400 }
    )
  }

  const accessKeyId = process.env.OSS_ACCESS_KEY_ID
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET
  const bucket = process.env.OSS_BUCKET
  const endpoint = process.env.OSS_ENDPOINT
  if (!accessKeyId || !accessKeySecret || !bucket || !endpoint) {
    return Response.json({ error: "服务端未配置 OSS 环境变量" }, { status: 500 })
  }

  const now = new Date()
  const ext = EXT_BY_MIME[mime] ?? "bin"
  // qbank/YYYY/MM/<uuid>.ext —— 目录按上传月份分片，避免单目录对象过多；uuid 防碰撞防覆盖
  const key = `${cfg.keyPrefix}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.${ext}`

  const policy = Buffer.from(
    JSON.stringify({
      expiration: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      conditions: [
        ["content-length-range", 0, cfg.maxBytes],
        { bucket },
        ["starts-with", "$key", cfg.keyPrefix],
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
