// 上传图片的切图：把手机拍的整页照片切成「上游不会二次缩放」的小片。
//
// 为什么必须切：上游多模态模型会把大图缩到总像素约 1300×1300（官方 vision 文档），
// 一张 4000×3000 的整页照片被这么一缩，A4 上的小字就糊成一片——这正是「图片解析不出来」
// 的主因（PDF 路径早就按同一口径切成 1×2，见 lib/pdf-client.js:194-200）。
//
// 口径与 PDF 完全一致：宽度归一到 A4@180dpi（1489px），每片 ≤1.6M 像素，JPEG q0.72。
// 这样同一页无论来自 PDF 还是拍照，模型看到的都是同一套像素密度。
//
// 只有这里 3 个函数碰 DOM：纯几何的 planImageTiles 可以直接在 node 里单测。

const MAX_PIXELS = 1_600_000
const MAX_TILES = 8
const MAX_WIDTH = 1489

/** 素材本身有问题（图片坏了 / 数量对不上）。这类错误重试没有意义，必须停车道。 */
export class SourceFileError extends Error {
  constructor(message) {
    super(message)
    this.name = "SourceFileError"
  }
}

/**
 * 算切图几何。纯函数——不碰 canvas，所以能在 node 里直接测。
 *
 * 两步缩放：先按 A4 宽度归一（小图不放大），再保证「片数 ≤ maxTiles」。
 * 片数由面积推出来（ceil(总像素 / 每片上限)），所以**不会出现第 9 片被悄悄丢掉**。
 */
export function planImageTiles(width, height, opts = {}) {
  const maxPixels = opts.maxPixels ?? MAX_PIXELS
  const maxTiles = opts.maxTiles ?? MAX_TILES
  const maxWidth = opts.maxWidth ?? MAX_WIDTH

  const w0 = Math.max(1, Math.floor(width || 0))
  const h0 = Math.max(1, Math.floor(height || 0))

  let scale = Math.min(1, maxWidth / w0)
  const scaled = w0 * scale * h0 * scale
  if (scaled > maxPixels * maxTiles) {
    scale *= Math.sqrt((maxPixels * maxTiles) / scaled)
  }

  const w = Math.max(1, Math.round(w0 * scale))
  const h = Math.max(1, Math.round(h0 * scale))
  // 98% 的余量：tileHeight 向上取整会让每片略大于理论面积，留一点就不越线
  const rows = Math.max(1, Math.min(maxTiles, Math.ceil((w * h) / (maxPixels * 0.98))))
  const tileHeight = Math.ceil(h / rows)

  return { width: w, height: h, rows, tileHeight, scale }
}

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      // EXIF 方向交给浏览器：手机竖拍的照片如果不认这个，模型看到的是躺倒的卷子
      return await createImageBitmap(file, { imageOrientation: "from-image" })
    } catch {
      // 少数格式（HEIC 转出来的）createImageBitmap 不认，退回 <img>
    }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new SourceFileError(`图片解码失败：${file.name}（请换成 png/jpg/webp）`))
      el.src = url
    })
  } finally {
    // 解码结果已经在元素里，URL 可以立刻释放（不释放会一直占着内存）
    URL.revokeObjectURL(url)
  }
}

/**
 * 把一张图切成若干片（每片一个 JPEG data URL）。
 * 一次绘制、多次裁剪：整张图只解码一次，画布用完立刻归零（照抄 pdf-client 的写法）。
 */
export async function imageTiles(file, opts = {}) {
  let img
  try {
    img = await decodeImage(file)
  } catch (err) {
    if (err instanceof SourceFileError) throw err
    throw new SourceFileError(`图片解码失败：${file?.name ?? "未知文件"}`)
  }

  const plan = planImageTiles(img.width, img.height, opts)
  const canvas = document.createElement("canvas")
  canvas.width = plan.width
  canvas.height = plan.height
  const tiles = []
  try {
    const ctx = canvas.getContext("2d", { alpha: false })
    ctx.fillStyle = "#ffffff" // JPEG 没有透明通道，先铺白底，否则透明区会变黑
    ctx.fillRect(0, 0, plan.width, plan.height)
    ctx.drawImage(img, 0, 0, plan.width, plan.height)

    for (let i = 0; i < plan.rows; i++) {
      const y = i * plan.tileHeight
      const h = Math.min(plan.tileHeight, plan.height - y)
      if (h <= 0) break
      const piece = document.createElement("canvas")
      piece.width = plan.width
      piece.height = h
      try {
        const pctx = piece.getContext("2d", { alpha: false })
        pctx.fillStyle = "#ffffff"
        pctx.fillRect(0, 0, plan.width, h)
        pctx.drawImage(canvas, 0, y, plan.width, h, 0, 0, plan.width, h)
        tiles.push({ dataUrl: piece.toDataURL("image/jpeg", 0.72), w: plan.width, h })
      } finally {
        piece.width = 0
        piece.height = 0
      }
    }
  } finally {
    canvas.width = 0
    canvas.height = 0
    // ImageBitmap 要显式关掉；<img> 没这个方法
    img.close?.()
  }

  if (tiles.length === 0) throw new SourceFileError(`图片没有任何可用的部分：${file?.name ?? "未知文件"}`)
  return { tiles, ...plan }
}

// ---------- 缓存 ----------
// 同一张图一次跑批里至少会被解码两次：本页一次、下一页取「上一页底部」再一次。
// 只留 2 条（当前页 + 上一页），再多就是拿内存换不必要的东西。
const cache = new Map()
const MAX_CACHE = 2

export function tilesFor(file, opts) {
  const hit = cache.get(file)
  if (hit) return hit
  const p = imageTiles(file, opts).catch((err) => {
    cache.delete(file) // 失败的不要留在缓存里
    throw err
  })
  cache.set(file, p)
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
  return p
}

export function clearTileCache() {
  cache.clear()
}
