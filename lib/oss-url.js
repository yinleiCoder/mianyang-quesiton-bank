// OSS 对象展示 URL 合成（同构模块：Server/Client 均可 import）。
// 库中媒体与头像只存相对 key（qbank/…、avatars/…），展示时拼 CNAME 公网域名；
// 兼容历史里可能已落库的完整 URL（http 开头直接透传，不重复拼接）。
//
// 图片额外走 OSS 图片处理（x-oss-process），在 OSS 侧缩到展示尺寸再回源：
// 实测一张题干插图原图 7,611,278 B，缩到 w_720 + webp 后 38,716 B（约 1/197），
// 而它在列表里只显示 320px 高 —— 不缩等于白烧流量，手机端尤其明显。
//
// 两条硬约束都在本文件内闭环，调用方不需要记得：
//   · 只有图片扩展名能带 x-oss-process。实测给 .xlsx 附带该参数会得到
//     HTTP 400「This image format is not supported.」，附件整条打不开。
//   · GIF 不能走 format,webp：动图会被转成静态图，动画丢失。GIF 只做等比缩放。
//
// 规则必须与 Flutter 端 mianyang_quiz/lib/core/network/oss_url.dart 逐条一致。

export function objectUrl(key) {
  if (!key) return ""
  if (/^https?:\/\//i.test(key)) return key
  const host = process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST
  return host ? `https://${host}/${key}` : ""
}

// 展示档位：调用方只挑档、不写像素，避免 320/640/1280 这类魔法数字各处漂移。
//   avatar 96   头像最大显示 44px（person-chip 浮层），覆盖 2x 屏
//   thumb  720  题干/选项内联插图（max-h-48 / max-h-80），覆盖 2x 屏
//   full   1600 全屏查看，需要细节
export const MEDIA_WIDTHS = { avatar: 96, thumb: 720, full: 1600 }

// 能被 OSS 图片处理接受的扩展名，与 lib/media-spec.js 的图片档一致。硬边界，别扩。
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"])
// 动图：只缩放，绝不 format 转换。
const ANIMATED_EXTS = new Set(["gif"])

function extOf(key) {
  const path = String(key).split(/[?#]/)[0]
  const dot = path.lastIndexOf(".")
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase()
}

// 不要加 limit_0：它的语义是「允许放大」，带上会把小图拉大（更糊也更慢）；
// 缺省的 limit_1 才是「只缩不放」，正是我们要的。
// quality 用绝对质量 Q_80 而非相对 q_80：相对质量 = 原图质量 × q%，对已被压过的图会二次劣化。
function processSpec(ext, width) {
  const w = Math.max(1, Math.min(16384, Math.round(width)))
  const resize = `image/resize,w_${w}`
  return ANIMATED_EXTS.has(ext) ? resize : `${resize}/quality,Q_80/format,webp`
}

// 媒体 key → 带图片处理的展示地址；非图片、非自有域名一律退化为原始地址。
export function mediaUrl(key, { width = MEDIA_WIDTHS.thumb } = {}) {
  const base = objectUrl(key)
  if (!base) return ""
  // 只处理自家 OSS 域名：库里兼容历史完整 URL，那些可能指向别处或自带签名，
  // 贸然追加查询参数会破坏它们。
  const host = process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST
  if (!host || !base.startsWith(`https://${host}/`)) return base
  const ext = extOf(key)
  if (!IMAGE_EXTS.has(ext)) return base
  return `${base}?x-oss-process=${processSpec(ext, width)}`
}

// 头像：固定小尺寸档（cover 场景与 objectUrl 同一域名规则，仅多一层缩放）。
export function avatarUrl(key) {
  return mediaUrl(key, { width: MEDIA_WIDTHS.avatar })
}
