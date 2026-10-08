// 导出 PDF 的"准备工作"：把一份卷面快照翻译成 react-pdf 需要的东西——
// 一份纯文字（缺字检查用）、一串要预取的图片、以及图片的排版尺寸。
//
// 卷面里的图是 OSS 直链，在网页上由浏览器直接渲染；react-pdf 拿不到 DOM，只能自己
// 把图**抓成字节**再嵌进 PDF。抓的同时顺手把宽高量出来——PDF 里得按比例摆，
// 不量宽高就只能写死尺寸，横图竖图一视同仁地拉变形。
//
// 抓失败（跨域被拦、图被删、网络抖动）不让导出整体失败：那一张退化成一行文字说明。
// 一张图没上去，用户看得见也说得清；整份导不出来，用户只会觉得"这功能坏了"。
import { mediaUrl, MEDIA_WIDTHS } from "@/lib/oss-url"

// 印之前要换掉的字。
//
// 只有一个：ASCII 连字符 U+002D → U+2011（非断连字符）。原因是断行——
// react-pdf 在音节边界断行时会**自己插一个 U+002D**，而字体里 U+002D 的字宽已经被
// 构建脚本改成 0（见 scripts/build-cjk-subset.mjs），那个自动连字符是隐形的。
// 正文里真正的连字符要是也用 U+002D，就会跟着一起隐形（"MY-2026-01" 变成 "MY2026 01"）。
// U+2011 的字形与宽度和 U+002D 完全一致（都是 347/1000 em），但它不是断行点，
// 也不会被引擎插到行尾——所以正文用它，隐形的那个只有引擎自己插的。
const HYPHEN = /-/g
// 用码点写而不是直接贴字符：U+2011 与 U+2010（连字符）、U+002D（减号）在编辑器里
// 长得一模一样，贴字符的话下一个人"顺手改一下"就会改错，而且看不出来。
const NB_HYPHEN = String.fromCharCode(0x2011)

export function printableText(text) {
  return String(text ?? "").replace(HYPHEN, NB_HYPHEN)
}

// 卷面快照里所有会被印出来的文字。用途只有一个：导出前拿字体字符集核对，
// 缺字就先说，别让用户对着 PDF 里的空白猜。
export function collectText(snapshot, { withAnswers = false } = {}) {
  const parts = [snapshot?.title, snapshot?.exam_name, snapshot?.subject_label, snapshot?.header?.code]
  const pushBlocks = (blocks) => {
    for (const b of blocks ?? []) {
      if (b?.t !== "text") continue
      parts.push(b.text)
      if (b.alt) parts.push(b.alt) // 附件/图片的说明文字也会印出来
    }
  }
  const walkContent = (c) => {
    if (!c) return
    pushBlocks(c.stem)
    for (const o of c.options ?? []) pushBlocks(o?.label)
    for (const s of c.sub ?? []) walkContent(s)
    if (withAnswers) {
      pushBlocks(c.analysis)
      const a = c.answer ?? {}
      for (const v of [...(a.values ?? []), ...(a.samples ?? [])]) parts.push(v)
      parts.push(...(a.keys ?? []))
    }
  }
  pushBlocks(snapshot?.instructions)
  for (const sec of snapshot?.sections ?? []) {
    parts.push(sec.title, sec.instruction)
    for (const item of sec.items ?? []) walkContent(item?.content)
  }
  return parts.filter(Boolean).join("\n")
}

// 卷面上图片的排版上限（pt）。A4 正文宽 595 - 左右各 40 = 515，再减去题号缩进。
export const IMAGE_MAX_WIDTH = 420
export const IMAGE_MAX_HEIGHT = 320

// 遍历一份卷面快照，收出所有图片 key（去重、保序）。
// 与 components/questions/question-view.jsx 的区块口径一致：只有 kind 不是
// audio/video/file 的 media 块才是图（kind 缺省也按图算）。
export function collectMediaKeys(snapshot, { withAnswers = false } = {}) {
  const keys = []
  const seen = new Set()

  const pushBlocks = (blocks) => {
    for (const b of blocks ?? []) {
      if (b?.t !== "media") continue
      if (b.kind === "audio" || b.kind === "video" || b.kind === "file") continue
      const key = b.key ?? b.url
      if (!key || seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }

  const walkContent = (c) => {
    if (!c) return
    pushBlocks(c.stem)
    for (const o of c.options ?? []) pushBlocks(o?.label)
    for (const s of c.sub ?? []) walkContent(s)
    if (withAnswers && !(c.sub?.length > 0)) pushBlocks(c.analysis)
  }

  for (const sec of snapshot?.sections ?? []) {
    for (const item of sec.items ?? []) walkContent(item?.content)
  }
  if (withAnswers) pushBlocks(snapshot?.instructions)
  return keys
}

// 按原图比例缩放到上限框内（纯函数，测试直接调）。宽高拿不到时给个方框兜底，
// 至少不会因为 NaN 把整页排版搞崩。
export function imageBox(width, height, maxW = IMAGE_MAX_WIDTH, maxH = IMAGE_MAX_HEIGHT) {
  const w0 = Number(width) > 0 ? Number(width) : 1
  const h0 = Number(height) > 0 ? Number(height) : 1
  const scale = Math.min(1, maxW / w0, maxH / h0)
  return { width: Math.round(w0 * scale), height: Math.round(h0 * scale) }
}

// react-pdf 能嵌进 PDF 的图片字节只有这四种。认不出来的必须在**抓取阶段**就拦下：
// 让它漏到渲染阶段的话，整份导出会一起失败，而不是那一张退化成占位文字。
// webp 是最容易漏进来的——展示地址默认就带 format,webp（见 lib/oss-url.js）。
const SNIFF = [
  { name: "png", sig: [0x89, 0x50, 0x4e, 0x47] },
  { name: "jpeg", sig: [0xff, 0xd8, 0xff] },
  { name: "gif", sig: [0x47, 0x49, 0x46, 0x38] },
]
// SVG 是文本，"<svg" 或 "<?xml" 开头都算
const looksLikeSvg = (bytes) => {
  const head = new TextDecoder().decode(bytes.slice(0, 64)).trimStart().toLowerCase()
  return head.startsWith("<svg") || head.startsWith("<?xml")
}

export function imageBytesKind(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (const { name, sig } of SNIFF) {
    if (sig.every((b, i) => u8[i] === b)) return name
  }
  return looksLikeSvg(u8) ? "svg" : "unknown"
}

// 一张图 → data URL + 宽高。只用浏览器 API（fetch / createImageBitmap），Node 端不调。
async function fetchImage(src) {
  const res = await fetch(src)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  const kind = imageBytesKind(new Uint8Array(await blob.slice(0, 64).arrayBuffer()))
  if (kind === "unknown") throw new Error("格式不在 PDF 支持范围内（只收 png / jpg / gif / svg）")
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error("读取失败"))
    fr.readAsDataURL(blob)
  })
  let width = 0
  let height = 0
  try {
    const bmp = await createImageBitmap(blob)
    width = bmp.width
    height = bmp.height
    bmp.close?.()
  } catch {
    // 量不出宽高不影响嵌图，排版那步会退回兜底方框
  }
  return { src: dataUrl, width, height }
}

// 批量取图：返回 Map<key, {src,width,height}>；单张失败记 null，调用方渲染占位。
// onProgress(done, total) 给按钮做进度文案——一份卷子十几张图，不显示进度像卡住了。
export async function prefetchImages(keys, onProgress) {
  const out = new Map()
  let done = 0
  await Promise.all(
    keys.map(async (key) => {
      // raw：只缩放不转 webp——react-pdf 不认 webp 字节（详见 oss-url.js 的说明）
      const url = mediaUrl(key, { width: MEDIA_WIDTHS.full, raw: true })
      try {
        out.set(key, url ? await fetchImage(url) : null)
      } catch {
        out.set(key, null)
      }
      done += 1
      onProgress?.(done, keys.length)
    })
  )
  return out
}
