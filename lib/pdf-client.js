"use client"

// 浏览器端 PDF 读取封装（批量导入题库的底层）：源文件永不出浏览器——
// 上层拿到的只是页文本 / 整页图 / 切片图，原始 PDF 不经任何服务器。
// 这里只负责"取素材"，题号识别与题目切分是上层工作台的事。
//
// 内存是这条链路的硬约束：几百页的扫描版 PDF 逐页位图累积能到上百兆，
// 所以 renderPage 渲染完立即 canvas.width = 0 + page.cleanup()（见该函数 finally）。
// 注意 handle 里握着 pdfjs 的 proxy，不可序列化，UI 层必须放 useRef 而不是 useState。

// pdfjs 主库 + worker 合计 ~1.5MB，首屏完全用不到；
// 动态 import 让打包器单独切 chunk，只有真正打开 PDF 时才下载。
let pdfjsPromise = null
// 图片算子集合：按当前安装版本的 OPS 常量表算一次（写死数字会在升级 pdfjs 时静默失效）
let imageOps = null

// 嵌入图 / 内联小图 / 扫描件最常见的 1-bit 位图底图都算"含图"
const IMAGE_OP_NAMES = [
  "paintImageXObject",
  "paintImageXObjectRepeat",
  "paintInlineImageXObject",
  "paintInlineImageXObjectGroup",
  "paintImageMaskXObject",
  "paintImageMaskXObjectRepeat",
  "paintImageMaskXObjectGroup",
  "paintSolidColorImageMask",
]

function loadPdfjs() {
  if (!pdfjsPromise) {
    // 用 legacy 构建而不是默认的现代构建，两个理由：
    // 1) 现代构建依赖 Uint8Array.prototype.toHex（很新的浏览器 API，旧内核浏览器没有），
    //    缺了它会在解析第一步就硬失败，不是降级而是直接报错；legacy 是同一份代码转译
    //    并补齐后的产物，新旧浏览器都能跑，代价只是体积略大——而这个包本来就是懒加载的。
    // 2) legacy 在 Node 下也能跑，这条链路因此能在构建之外被真正验证一次（见报告）。
    // 主库与 worker 必须同一套构建，不能一个 legacy 一个现代。
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs")
      .then((pdfjs) => {
        // worker 必须是打包器产出后的真实 URL：pdfjs 把解析放在 worker 线程，主线程只收结果。
        // 写死 "/pdf.worker.min.mjs" 这类常量在打包后必然 404；
        // new URL(裸包名, import.meta.url) 是打包器能静态识别的写法，会把 worker
        // 当资源产出并替换成本站实际地址。worker 本身也因此在首屏之外。
        // worker 取 .min 版：它是当静态资源原样发给浏览器的，不经过打包器压缩。
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString()
        imageOps = new Set(
          IMAGE_OP_NAMES.map((name) => pdfjs.OPS[name]).filter((v) => typeof v === "number")
        )
        return pdfjs
      })
      .catch((err) => {
        // 加载失败（断网 / 脚本被拦截）不要把失败的 promise 永久缓存住，否则重试也没用
        pdfjsPromise = null
        throw err
      })
  }
  return pdfjsPromise
}

// ---------- 文本项测量（probe 与 getPageText 共用，避免两处口径不一致） ----------
const itemX = (it) => it.transform[4]
const itemY = (it) => it.transform[5]
// 字号取变换矩阵的纵向量长（含旋转/缩放）：比读 it.height 稳，
// 后者在不同 pdfjs 版本里的语义有漂移
const itemSize = (it) => Math.hypot(it.transform[2], it.transform[3]) || it.height || 0

// 文本项分两种用途，别用同一个过滤器：
//  · 版面测量（栏位/字号/有没有字）只看有内容的项；
//  · 拼正文必须连空白项一起留着——pdfjs 会把词间空格单独吐成一个 " " 项，
//    丢掉它英文和数字就粘成一片（"A. one B. two" -> "A. oneB. two"）。
function textItemsOf(textContent) {
  return (textContent?.items ?? []).filter(
    (it) => typeof it?.str === "string" && Array.isArray(it.transform)
  )
}
const isBlankItem = (it) => it.str.trim().length === 0

// 分栏是"猜"出来的：pdfjs 不提供栏信息，只能看文本项 x 的分布。
// 两栏正文在页面中部会留出一条几乎没有文字起点的竖向空带；单栏正文哪怕长短不齐，
// 起点也会铺满整行宽度。宁可判成单栏也不要错判——错判会把左右两栏的文字绞在一起。
const COLUMN_BUCKETS = 24

function columnSplit(items, minX, maxX) {
  // 文本项太少时直方图没有统计意义
  if (items.length < 8) return null
  const span = maxX - minX
  if (span <= 0) return null
  const buckets = new Array(COLUMN_BUCKETS).fill(0)
  for (const it of items) {
    const i = Math.min(
      COLUMN_BUCKETS - 1,
      Math.max(0, Math.floor(((itemX(it) - minX) / span) * COLUMN_BUCKETS))
    )
    buckets[i] += 1
  }
  // 找最长的一段连续空桶；首尾的空桶是页边距，不参与
  let bestStart = -1
  let bestLen = 0
  let runStart = -1
  for (let i = 1; i < COLUMN_BUCKETS - 1; i++) {
    if (buckets[i] === 0) {
      if (runStart < 0) runStart = i
      if (i - runStart + 1 > bestLen) {
        bestLen = i - runStart + 1
        bestStart = runStart
      }
    } else {
      runStart = -1
    }
  }
  if (bestLen < 2) return null
  const split = minX + (bestStart + bestLen / 2) * (span / COLUMN_BUCKETS)
  // 空带要落在正中才像栏间沟；偏向一侧的多半是首行缩进或表格留白
  const rel = (split - minX) / span
  if (rel < 0.3 || rel > 0.7) return null
  const left = items.filter((it) => itemX(it) < split).length
  // 两侧都得有足够分量的文字，否则只是某几行特别短
  if (left < items.length * 0.2 || items.length - left < items.length * 0.2) return null
  return split
}

function measurePage(textContent) {
  const all = textItemsOf(textContent)
  // 测量一律用"有内容的项"：空白项只是排版缝隙，会稀释字号均值、也撑不满分栏统计
  const items = all.filter((it) => !isBlankItem(it))
  if (items.length === 0) {
    return { all, items, hasText: false, charCount: 0, columns: 1, avgFontSize: 0, splitX: null }
  }
  let minX = Infinity
  let maxX = -Infinity
  let sizeSum = 0
  let charCount = 0
  for (const it of items) {
    const x = itemX(it)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    sizeSum += itemSize(it)
    // 字数只数有内容的项（含它们内部的空格），不含词间那些独立的 " " 项——
    // 这个值是给上层判断"这页是文字版还是扫描件"用的，掺进排版缝隙会虚高
    charCount += it.str.length
  }
  const splitX = columnSplit(items, minX, maxX)
  return {
    all,
    items,
    hasText: true,
    charCount,
    columns: splitX == null ? 1 : 2,
    avgFontSize: Math.round((sizeSum / items.length) * 100) / 100,
    splitX,
  }
}

// 一栏内按阅读顺序拼文本：先按 y 从上到下（PDF 的 y 轴向上，故降序），同一行的再按 x 从左到右。
// 行内直接拼接、不补空格——pdfjs 的 getTextContent 已按字距把空格作为独立文本项吐出来了，
// 再补一次会把中文之间塞进多余空格。
function columnLines(items) {
  const sorted = [...items].sort((a, b) => itemY(b) - itemY(a) || itemX(a) - itemX(b))
  const lines = []
  let line = null
  for (const it of sorted) {
    const y = itemY(it)
    if (line && Math.abs(y - line.y) <= Math.max(1, line.size * 0.5)) {
      line.items.push(it)
    } else {
      line = { y, size: itemSize(it) || 10, items: [it] }
      lines.push(line)
    }
  }
  return lines
    .map((l) =>
      l.items
        .sort((a, b) => itemX(a) - itemX(b))
        .map((it) => it.str)
        .join("")
        .trim()
    )
    .filter((s) => s.length > 0)
}

// 拼正文一律用 all（含空白项），栏位归属也按 all 划，否则栏边界上的空格项会被吞掉
function pageTextFrom(measured) {
  if (measured.items.length === 0) return ""
  if (measured.columns < 2) return columnLines(measured.all).join("\n")
  // 双栏：pdfjs 的默认顺序会在左右栏之间来回跳，必须自己按 x 分栏，先读完左栏再读右栏
  const left = measured.all.filter((it) => itemX(it) < measured.splitX)
  const right = measured.all.filter((it) => itemX(it) >= measured.splitX)
  return [...columnLines(left), ...columnLines(right)].join("\n")
}

// ---------- 打开 ----------
// 上游多模态模型会把大图缩到"总像素约相当于 1300×1300"（官方 vision 文档），
// 单图另有一个 1024 token 的上限。据此定切图规则：
//   · 每片的总像素必须 ≤ 这个阈值，否则上游还会再缩一次——切了等于白切；
//   · 阈值用 1.6M 而不是精确的 169 万，留一点余量（不同版本可能微调）。
// A4 竖版按 180dpi 上下切两片 = 1489×1052 ≈ 1.57M ✓ 不再被缩，宽度 1489px
// 比整页送（会被缩到 ~1090px 宽）多出约 36% 的线性分辨率，代价只是 2 张图。
const TILE_MAX_PIXELS = 1_600_000

export async function openPdf(file) {
  const pdfjs = await loadPdfjs()
  let task = null
  let doc = null
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    // 四组外部资源必须显式给地址（都在 public/pdfjs/ 下，由 pdfjs 按需自取，不进打包产物）：
    //  · cmaps：中文 PDF 若用了预定义 CJK CMap 且未内嵌字体，没有它**取不到任何文字**——
    //    对中文题库来说这不是优化，是能不能用的区别；
    //  · wasm：JBIG2 / JPEG2000 解码器。扫描件（尤其双色调黑白扫描）基本都是这两种编码，
    //    缺了它 renderPage 会直接失败——而扫描试卷正是本功能的主要输入；
    //  · standardFonts：PDF 用到 14 种标准字体又不内嵌时的回退字形，影响渲染出的图；
    //  · iccs：色彩配置文件（qcms），体积很小，一并给上。
    // 结尾斜杠是必需的：pdfjs 会把文件名直接拼在后面。
    task = pdfjs.getDocument({
      data: bytes,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      iccUrl: "/pdfjs/iccs/",
    })
    doc = await task.promise
  } catch (err) {
    // 打开失败的 loadingTask 也要销毁，否则它内部起的 worker 会一直挂着
    try {
      await task?.destroy()
    } catch {
      // 已经坏了，销毁失败无所谓
    }
    if (err?.name === "PasswordException") {
      throw new Error("PDF 打开失败：文件已加密，请先解除密码保护再导入")
    }
    throw new Error("PDF 打开失败：文件已损坏或加密")
  }

  let destroyed = false
  const assertAlive = () => {
    if (destroyed) throw new Error("PDF 已关闭，请重新打开文件")
  }

  async function probe(pageNo) {
    assertAlive()
    const page = await doc.getPage(pageNo)
    try {
      const measured = measurePage(await page.getTextContent())
      // 图片判定走算子列表：文本层看不出插图，只有渲染指令流里才有 paintImageXObject 之类
      const opList = await page.getOperatorList()
      return {
        hasText: measured.hasText,
        charCount: measured.charCount,
        columns: measured.columns,
        avgFontSize: measured.avgFontSize,
        hasImage: opList.fnArray.some((fn) => imageOps?.has(fn)),
      }
    } finally {
      // 算子列表会把页里嵌的图在 worker 侧解码出来，扫描件逐页 probe 累积一样能吃满内存，
      // 所以这里也放掉。cleanup 之后同一页仍可正常再取文本 / 再渲染，代价只是重新解析一次
      page.cleanup()
    }
  }

  async function getPageText(pageNo) {
    assertAlive()
    const page = await doc.getPage(pageNo)
    // 这里不 cleanup：纯文本项体积很小（每页几 KB），不值得为它多付一次重新解析
    return pageTextFrom(measurePage(await page.getTextContent()))
  }

  async function renderPage(pageNo, opts = {}) {
    assertAlive()
    const tilesMode = opts.mode === "tiles"
    const columns = Math.max(1, Math.floor(opts.columns ?? 2))
    const rows = Math.max(1, Math.floor(opts.rows ?? 3))
    const quality = opts.quality ?? 0.72
    const requestedDpi = opts.dpi ?? (tilesMode ? 180 : 150)

    const page = await doc.getPage(pageNo)
    let canvas = null
    try {
      const base = page.getViewport({ scale: 1 })
      let dpi = requestedDpi
      if (tilesMode) {
        // 把"每片总像素 ≤ TILE_MAX_PIXELS"折算成整页 dpi 上限：
        //   每片像素 = (base.w·s/columns)·(base.h·s/rows) ≤ LIMIT，其中 s = dpi/72
        //   ⇒ dpi ≤ 72·√(LIMIT·columns·rows / (base.w·base.h))
        // 超出就自动下调 dpi——切片模式宁可糊一点，也不能让上游再缩一次（那就白切了）。
        // 单张模式不下调：反正送整页一定被缩，交给上游缩放不比我们自己缩差。
        const cap = 72 * Math.sqrt((TILE_MAX_PIXELS * columns * rows) / (base.width * base.height))
        dpi = Math.min(requestedDpi, cap)
      }
      const viewport = page.getViewport({ scale: dpi / 72 })
      canvas = document.createElement("canvas")
      // 向下取整：宁可少一个像素，也要保证切片后每片都不越 800
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      const ctx = canvas.getContext("2d", { alpha: false })
      // PDF 页面本身没有背景色（透明），JPEG 又不支持透明，
      // 不铺白底导出的图会变成黑块
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: ctx, viewport }).promise

      const tiles = []
      if (!tilesMode) {
        tiles.push({
          dataUrl: canvas.toDataURL("image/jpeg", quality),
          w: canvas.width,
          h: canvas.height,
          index: 0,
        })
      } else {
        // tileW 用 ceil：最后一列/行会短一截（下面按剩余像素裁），但每片都不会超过 800
        const tileW = Math.ceil(canvas.width / columns)
        const tileH = Math.ceil(canvas.height / rows)
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < columns; c++) {
            const sx = c * tileW
            const sy = r * tileH
            const sw = Math.min(tileW, canvas.width - sx)
            const sh = Math.min(tileH, canvas.height - sy)
            if (sw <= 0 || sh <= 0) continue
            const piece = document.createElement("canvas")
            piece.width = sw
            piece.height = sh
            const pieceCtx = piece.getContext("2d", { alpha: false })
            pieceCtx.fillStyle = "#ffffff"
            pieceCtx.fillRect(0, 0, sw, sh)
            pieceCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
            tiles.push({
              dataUrl: piece.toDataURL("image/jpeg", quality),
              w: sw,
              h: sh,
              index: tiles.length, // 行优先，上层按 idx 顺序喂给模型
            })
            // 切片也要即时释放：一张 1500×1050 的 canvas 就是 ~6MB，多页累积很可观
            piece.width = 0
            piece.height = 0
          }
        }
      }
      // pageWidth/pageHeight 是渲染后的像素尺寸，不是 PDF 的点尺寸——上层排版看的是位图
      return { pageWidth: canvas.width, pageHeight: canvas.height, tiles, dpi: Math.round(dpi * 100) / 100 }
    } finally {
      // 位图不主动清零要等 GC，一本几百页的 PDF 会先把内存吃满
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      page.cleanup()
    }
  }

  async function destroy() {
    if (destroyed) return
    destroyed = true
    try {
      // 销毁必须走 loadingTask：pdfjs v6 的 PDFDocumentProxy 上根本没有 destroy()
      // （只有 cleanup(keepLoadedFonts)），能收掉 worker 和网络请求的是 loadingTask。
      await task.destroy()
    } catch {
      // 已关闭 / 已损坏的文档再销毁会抛，幂等语义下直接吞掉
    }
  }

  return { pageCount: doc.numPages, probe, getPageText, renderPage, destroy }
}
