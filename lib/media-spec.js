// 媒体类型白名单与大小上限的**唯一真源**：服务端预签名（app/api/oss/sign）与前端上传器
// （components/media-uploader）都从这里取，避免 mime 清单和上限在多处各写一份而漂移。
// 改动前这些信息散在三处（sign 路由的 mimeRe、同文件的 EXT_BY_MIME、上传器的 accept 表），
// 代码里那句「白名单须与前端保持一致」的警告就是这种维护痛点的自白——现在它们同源了。
//
// 注意：本模块会被打进客户端 bundle——禁止 import node 内置模块，也不要放任何秘密。

const MB = 1024 * 1024
const GB = 1024 * MB

// 分档上限。上限挂在**档位**而不是单个 mime 上：错误文案、提示文案、OSS policy 的
// content-length-range 都从 TIERS[tier] 一处取值，调档位即全局生效。
export const TIERS = {
  avatar: { label: "头像图片", maxBytes: 5 * MB },
  image: { label: "图片", maxBytes: 20 * MB },
  audio: { label: "音频", maxBytes: 200 * MB },
  video: { label: "视频", maxBytes: 1 * GB },
  document: { label: "文档", maxBytes: 200 * MB },
}

// mime → { tier, ext, accept? }。ext 用于生成对象 key；accept 是扩展名别名，缺省即 [ext]。
const QUESTION_MEDIA_TYPES = {
  "image/png": { tier: "image", ext: "png" },
  "image/jpeg": { tier: "image", ext: "jpg", accept: ["jpg", "jpeg"] },
  "image/webp": { tier: "image", ext: "webp" },
  "image/gif": { tier: "image", ext: "gif" },
  "audio/mpeg": { tier: "audio", ext: "mp3" },
  "audio/wav": { tier: "audio", ext: "wav" },
  "audio/ogg": { tier: "audio", ext: "ogg" },
  "video/mp4": { tier: "video", ext: "mp4" },
  "video/webm": { tier: "video", ext: "webm" },
  "application/pdf": { tier: "document", ext: "pdf" },
  "application/msword": { tier: "document", ext: "doc" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    tier: "document",
    ext: "docx",
  },
  "application/vnd.ms-excel": { tier: "document", ext: "xls" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    tier: "document",
    ext: "xlsx",
  },
  "application/vnd.ms-powerpoint": { tier: "document", ext: "ppt" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    tier: "document",
    ext: "pptx",
  },
  "text/plain": { tier: "document", ext: "txt" },
  "text/markdown": { tier: "document", ext: "md" },
  "text/csv": { tier: "document", ext: "csv" },
}

const AVATAR_TYPES = {
  "image/png": { tier: "avatar", ext: "png" },
  "image/jpeg": { tier: "avatar", ext: "jpg", accept: ["jpg", "jpeg"] },
  "image/webp": { tier: "avatar", ext: "webp" },
}

export const PURPOSES = {
  question_media: { keyPrefix: "qbank/", types: QUESTION_MEDIA_TYPES },
  avatar: { keyPrefix: "avatars/", types: AVATAR_TYPES },
}

// mime 比较一律先归一化：HTTP 头的类型不区分大小写，而浏览器给的值大小写不定。
const normalize = (mime) => String(mime ?? "").toLowerCase()

/** 该用途下这个 mime 的记录；null 表示不支持该类型。 */
export function typeFor(purpose, mime) {
  return PURPOSES[purpose]?.types[normalize(mime)] ?? null
}

/** 该用途下这个 mime 属于哪一档；null 表示类型不支持。 */
export function tierFor(purpose, mime) {
  const type = typeFor(purpose, mime)
  return type ? TIERS[type.tier] : null
}

/** 字节数 → 人类可读上限。 */
export function formatLimit(bytes) {
  return bytes >= GB ? `${bytes / GB}GB` : `${Math.round(bytes / MB)}MB`
}

/**
 * 超限文案。服务端的 400 与前端 validator 共用这一句——两处各写一句迟早会漂移，
 * 而用户看到的必须是同一条规则。
 */
export function tooLargeMessage(purpose, mime) {
  const tier = tierFor(purpose, mime)
  return tier ? `${tier.label}不能超过 ${formatLimit(tier.maxBytes)}` : "文件过大"
}

/** react-dropzone 的 accept 结构：{ mime: [".ext", ...] }。 */
export function acceptMap(purpose) {
  const types = PURPOSES[purpose]?.types ?? {}
  return Object.fromEntries(
    Object.entries(types).map(([mime, t]) => [mime, (t.accept ?? [t.ext]).map((e) => `.${e}`)])
  )
}

/** 该用途下所有允许的扩展名（去重）。删除路由用它构造 key 正则。 */
export function extsFor(purpose) {
  const types = PURPOSES[purpose]?.types ?? {}
  return [...new Set(Object.values(types).map((t) => t.ext))]
}

/** 各档上限的一句话摘要，如「图片 ≤20MB、音频 ≤200MB」。按声明顺序去重。 */
export function limitsHint(purpose) {
  const types = PURPOSES[purpose]?.types ?? {}
  const seen = new Map()
  for (const t of Object.values(types)) {
    const tier = TIERS[t.tier]
    if (!seen.has(tier.label)) seen.set(tier.label, formatLimit(tier.maxBytes))
  }
  return [...seen].map(([label, limit]) => `${label} ≤${limit}`).join("、")
}
