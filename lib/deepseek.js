// DeepSeek 客户端（**只在浏览器里用**）：拼请求、调用、把"模型没按格式返回"尽量抢救回来。
// 题目语义的规范化是 lib/import-pipeline.js 的事，这里不掺和。
//
// 密钥由使用者自己提供，从参数传入：请求从浏览器直达上游（官方 API 支持 CORS，已实测），
// **密钥不经过我们的服务器，站点也不提供公共密钥**——解析费用完全由使用者承担。
// 因此本模块不读 process.env，也没有任何服务端调用路径。
//
// 上游事实（2026-09 核实，改动前请重新核对官方文档）：
//   · OpenAI 兼容：POST {base}/chat/completions，模型 deepseek-flash（支持视觉）；
//   · 图片只能出现在 user 消息里，system/assistant 带图会 400；
//   · 单请求体 ≤48MiB、单图 ≤32MiB、单请求最多 600 张图；
//   · 支持 response_format: {type:"json_object"}；
//   · 上下文 1M、最大输出 384K；单图最多占 384 token（会被自动缩到约 800×800 等价像素）。

export const DEFAULT_BASE = "https://api.deepseek.com"
export const DEFAULT_MODEL = "deepseek-flash"

// 可选模型（界面上给选择框用）。vision 决定"能不能解析扫描件/拍照页"——
// 选错不会静默出错，但会白跑一趟，所以 parseOnePage 里有一道前置拦截。
export const DEEPSEEK_MODELS = [
  {
    value: "deepseek-flash",
    label: "deepseek-flash（推荐）",
    hint: "支持图像理解：扫描件、拍照的试卷都能解析；速度快、价格低",
    vision: true,
  },
  {
    value: "deepseek-v4-pro",
    label: "deepseek-v4-pro",
    hint: "纯文本能力更强，但不支持图片——扫描件/拍照页会解析失败，只适合文字版 PDF 与 Word",
    vision: false,
  },
]

/** 未知模型返回 true：不拦将来新增的模型，只拦明确不支持图像的。 */
export const modelSupportsVision = (model) =>
  DEEPSEEK_MODELS.find((m) => m.value === model)?.vision ?? true

/**
 * 用一次极小的请求验证密钥能不能用（顺带验证模型名）。花不到 1 分钱，
 * 但能在跑大批量之前就发现问题——比"解析到第 3 页才发现密钥是错的"划算得多。
 */
export async function testDeepSeekKey({ apiKey, model = DEFAULT_MODEL, baseUrl = DEFAULT_BASE }) {
  try {
    await callChat({
      messages: [{ role: "user", content: "ping" }],
      apiKey,
      model,
      baseUrl,
      maxTokens: 1,
      timeoutMs: 20000,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err?.message ?? "测试失败", detail: err?.detail ?? null }
  }
}

/**
 * 把上游的错误响应体变成一句能显示给用户的话。
 * DeepSeek 的 400/401/402 里都带具体的 error.message（如 "Model Not Exist"、
 * "This model does not support image"），不给用户看就只能盲猜。
 */
export function upstreamReason(detail) {
  if (!detail) return ""
  try {
    const j = typeof detail === "string" ? JSON.parse(detail) : detail
    const m = j?.error?.message ?? j?.message ?? j?.error ?? ""
    if (m) return String(m).slice(0, 300)
  } catch {
    // 不是 JSON 就退回原文
  }
  return String(detail).replace(/\s+/g, " ").slice(0, 300)
}

export class UpstreamError extends Error {
  constructor(message, { status = 502, transient = true, detail = null } = {}) {
    super(message)
    this.name = "UpstreamError"
    this.status = status // 给路由用的 HTTP 状态
    this.transient = transient // true = 值得重试（交给页级状态机）
    this.detail = detail
  }
}

// 模型偶尔会在 JSON 前后加解释或代码块围栏；先剥围栏，再截取最外层大括号。
// 这是"抢救"而不是"解析"：真正的容错在 pipeline 的规范化里。
export function salvageJson(text) {
  if (typeof text !== "string") return null
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  try {
    return JSON.parse(s)
  } catch {
    // 被截断（finish_reason=length）时，尽可能救出完整的题目对象
  }
  const start = s.indexOf("{")
  if (start < 0) return null
  const end = s.lastIndexOf("}")
  if (end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1))
    } catch {
      /* 继续尝试截断抢救 */
    }
  }
  const qs = s.indexOf('"questions"')
  if (qs < 0) return null
  const arrStart = s.indexOf("[", qs)
  if (arrStart < 0) return null
  // 逐个对象取：括号配对，遇到解析失败就停在上一个完整对象
  const objs = []
  let depth = 0
  let objStart = -1
  let inStr = false
  let esc = false
  for (let i = arrStart + 1; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === "{") {
      if (depth === 0) objStart = i
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0 && objStart >= 0) {
        try {
          objs.push(JSON.parse(s.slice(objStart, i + 1)))
        } catch {
          break
        }
        objStart = -1
      }
    } else if (ch === "]" && depth === 0) {
      break
    }
  }
  if (objs.length === 0) return null
  return { questions: objs, _salvaged: true }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 调一次聊天补全。失败按「瞬时/永久」分类抛出 UpstreamError。
 * 内部已做 2 次短退避重试；仍失败就交给上层（页级状态机会再重试，attempts ≤ 3）。
 */
export async function callChat({
  messages,
  apiKey,
  baseUrl = DEFAULT_BASE,
  model = DEFAULT_MODEL,
  maxTokens = 32000,
  timeoutMs = 180000,
  // 官方《温度设置》对「数据抽取/分析」推荐 1.0（默认值也是 1.0）。
  // 这里照官方来；若实测发现抽取幻觉偏多，再往下调（0.7 左右）并记录实测结果。
  temperature = 1.0,
}) {
  if (!apiKey) {
    throw new UpstreamError("没有可用的 DeepSeek 密钥", { status: 401, transient: false })
  }
  const base = baseUrl.replace(/\/+$/, "")

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    stream: false,
  })

  // 上游限制写死在代码里（防的是把超大 payload 送上去，不是防模型）。
  // 用 TextEncoder 而不是 Buffer：这个模块前后端都要能跑。
  if (new TextEncoder().encode(body).length > 40 * 1024 * 1024) {
    throw new UpstreamError("本批内容过大，请减少一次处理的页数", { status: 413, transient: false })
  }

  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt === 1 ? 1000 : 4000)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        // 上游的错误体可能很长，截断保留；同时**抹掉任何形似密钥的串**，
        // 免得它出现在页面的错误提示里（密钥不进日志也不进界面）
        const detail = (text ?? "").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***").slice(0, 500)
        // 429/5xx 是瞬时的；401/403（密钥问题）与 400（请求格式）重试没有意义
        const transient = res.status === 429 || res.status >= 500
        // 401 = 密钥本身被拒（余额不足是 402，不是 401），所以提示要指向"密钥复制是否正确"。
        // 末尾一律附上上游给的具体原因——400 这类错误没有它就是抓瞎。
        const reason = upstreamReason(detail)
        const base =
          res.status === 401
            ? "密钥被 DeepSeek 拒绝（401）：请确认复制的是完整的 sk- 开头的密钥（没有多带 Bearer、引号或空格），且该密钥仍然有效"
            : res.status === 403
              ? "密钥没有访问该模型的权限（403）：请确认账号已开通所选模型"
              : res.status === 402
                ? "DeepSeek 账号余额不足（402）：请先充值"
                : res.status === 400
                  ? `DeepSeek 认为这次请求不合法（400）`
                  : `解析服务返回 ${res.status}`
        const msg = reason ? `${base}　上游原话：${reason}` : base
        lastErr = new UpstreamError(msg, {
          status: transient ? 502 : 400,
          transient,
          detail,
        })
        if (!transient) throw lastErr
        continue
      }
      const json = await res.json()
      const choice = json?.choices?.[0]
      return {
        content: choice?.message?.content ?? "",
        finishReason: choice?.finish_reason ?? null,
        usage: json?.usage ?? {},
        model: json?.model ?? model,
      }
    } catch (err) {
      if (err instanceof UpstreamError) {
        if (!err.transient) throw err
        lastErr = err
        continue
      }
      // AbortError / 网络错误：都是瞬时的
      const isAbort = err?.name === "AbortError"
      lastErr = new UpstreamError(isAbort ? "解析超时" : "解析服务连接失败", {
        status: 504,
        transient: true,
        detail: String(err?.message ?? err),
      })
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new UpstreamError("解析失败", { status: 502, transient: true })
}
