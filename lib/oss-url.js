// OSS 对象展示 URL 合成（同构模块：Server/Client 均可 import）。
// 库中媒体与头像只存相对 key（qbank/…、avatars/…），展示时拼 CNAME 公网域名；
// 兼容历史里可能已落库的完整 URL（http 开头直接透传，不重复拼接）。
export function objectUrl(key) {
  if (!key) return ""
  if (/^https?:\/\//i.test(key)) return key
  const host = process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST
  return host ? `https://${host}/${key}` : ""
}

// 封面/头像缩略等场合与 objectUrl 同一规则
export function avatarUrl(key) {
  return objectUrl(key)
}
