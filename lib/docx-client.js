"use client"

// 浏览器端 .docx 读取封装（批量导入题库的底层）：只把本地 Word 文件变成纯文本 + 段落数组，
// 不做题号识别、不做题目切分——那是上层工作台的事。源文件永不出浏览器。
//
// 设计决定：这里不产出任何"页"信息（没有 pageCount，也没有按页切片）。
// Word 文档里根本不存在页——分页是 Word/WPS 渲染时按纸张、字号、边距算出来的结果，
// 同一个 .docx 换个打印机页数就变，文件本身不存页边界。硬造页数只会给上层假精度。
// 因此上层用 paragraphs 做"题号范围"选择，而不是"第几页到第几页"。

let mammothPromise = null

function loadMammoth() {
  if (!mammothPromise) {
    // 走预打包的浏览器版：mammoth 的 lib/ 里有 require("fs") / require("path")，
    // 在 Turbopack 客户端构建下解析不了；mammoth.browser.js 是自包含的 UMD bundle，
    // 一个 node 内置模块都不碰（bundle 里 require 内置模块的次数为 0）。
    // UMD 的 exports 在 CJS 互操作下可能落在 default 上，两种都兜住。
    // 带 .js 后缀：mammoth 没有 exports 字段，裸写 mammoth/mammoth.browser 在
    // 打包器里能靠扩展名补全猜中，但在标准 ESM 解析（node）下会直接找不到模块。
    mammothPromise = import("mammoth/mammoth.browser.js")
      .then((mod) => mod.default ?? mod)
      .catch((err) => {
        // 一次加载失败不永久缓存，用户重试时还能再来
        mammothPromise = null
        throw err
      })
  }
  return mammothPromise
}

// 读取本地 .docx → { text, paragraphs, hasImages, charCount }
export async function extractDocx(file) {
  const mammoth = await loadMammoth()
  let buffer
  try {
    buffer = await file.arrayBuffer()
  } catch {
    // 选完文件后源文件被移动/删除时才会走到这里
    throw new Error("Word 文档读取失败：文件已被移动或删除，请重新选择")
  }
  let raw
  let html
  try {
    // 两次调用各自要解一遍 zip，彼此独立，并发跑省一半等待；
    // 传 buffer.slice(0) 而不是同一个 buffer，避免依赖 mammoth 内部"只读不转移"的实现细节
    const [rawResult, htmlResult] = await Promise.all([
      mammoth.extractRawText({ arrayBuffer: buffer }),
      mammoth.convertToHtml({ arrayBuffer: buffer.slice(0) }),
    ])
    raw = rawResult.value
    html = htmlResult.value
  } catch {
    // .doc（旧二进制格式）/ 损坏文件 / 加密文档都会在这里失败
    throw new Error("Word 文档解析失败：请另存为 .docx 后重试")
  }

  // mammoth 的原始文本用空行分段（段落之间是 \n\n），统一成 \n 后按行切，
  // 空行一并去掉——上层要的是"可点选的段落清单"，空行只是噪声
  const text = raw.replace(/\r\n?/g, "\n")
  const paragraphs = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return {
    text,
    paragraphs,
    // 题干常把图放在正文里，纯文本会丢掉这部分信息；
    // 含图时上层提示改走 PDF / 图片路径（本模块只负责报出来）
    hasImages: /<img[\s/>]/i.test(html),
    charCount: text.length,
  }
}

// ---------- 按内容对齐的取窗 ----------
//
// 为什么不能简单地 `paragraphs.slice(n-1, n+4)`：Word 卷子的排版是
// **题干一段、选项一段**（四个选项用制表符排在同一段里）。固定切 5 段时，
// 窗口末尾常落在一道题的题干上——它的选项就在下一段，被切掉了。
// 模型于是只能抽出一道没有选项的选择题，入库时被 validate_question_content
// 判为「选择题至少需要 2 个选项」而失败。反方向同理：窗口以选项段开头时，题干在外面。
// 实测：一份 200 段的真题按固定切窗，前几页就有两道题是残缺的。

// 选项段的判据：一段里出现两个以上 "A."/"B、"/"C．" 这类选项标号。
// 用"至少两个不同字母"而不是"包含 A."，避免把提到 "A." 的题干误判成选项段。
const OPTION_MARK_RE = /(?:^|\s)([A-D])\s*[.、．:：)）]\s*\S/g

export function looksLikeOptions(p) {
  const seen = new Set()
  for (const m of p.matchAll(OPTION_MARK_RE)) seen.add(m[1])
  return seen.size >= 2
}

// 题干段的判据：以括号空位收尾（选择题的「（）」），或以题号开头
const STEM_TAIL_RE = /[（(]\s*[）)]\s*[。.．]?\s*$/
const QNO_HEAD_RE = /^\s*(?:\d{1,3}\s*[.、．]|[（(]\s*\d{1,3}\s*[）)])/

export function looksLikeStem(p) {
  return STEM_TAIL_RE.test(p) || QNO_HEAD_RE.test(p)
}

/**
 * 取第 pageNo 批段落，并把窗口边界对齐到题目边界上。
 * @returns { start, end, extendedForward, extendedBackward, text }
 *   start/end 是 0 基、end 不含；text 是拼好的这批内容。
 */
export function docxWindow(paragraphs, pageNo, { size = 5, maxExtend = 6 } = {}) {
  const total = paragraphs.length
  const start0 = Math.max(0, pageNo - 1)
  let start = start0
  let end = Math.min(total, start0 + size)

  // 向后：窗口不能在**题目中间**结束。
  //
  // 判据只看"紧跟着的那一段是不是新题的题干"：
  //   · 是 → 说明当前这道题已经结束，正好停在题目边界上，不动；
  //   · 不是 → 说明窗口把某道题切在了半路，继续吃。
  //
  // 为什么不用更直观的"末段是不是题干"：选项不总是一段。
  //   · 有的卷子四个选项排在一段里（制表符分隔）；
  //   · 有的卷子每个选项独占一段，**而且不带 A./B./C./D. 标号**——
  //     那份单招卷的「关于计算机接口…」就是四段纯文本，题干夹在窗口中间，
  //     按末段判根本触发不了，只会吃到第一个选项 → 入库报「选择题至少需要 2 个选项」。
  //
  // 代价：窗口平均从 5 段涨到 ~7.4 段（约 +49% 输入）。值——
  // 切坏的题是整道作废，而多出来的输入比重新解析一遍便宜得多。
  // 更好的做法是按"题"切块（一段题干 + 它的选项）而不是按固定段数切窗，
  // 那样窗口能缩到 2 段且永不切坏；留作后续优化。
  let forward = 0
  while (end < total && forward < maxExtend && !looksLikeStem(paragraphs[end])) {
    end += 1
    forward += 1
  }

  // 开头落在选项上 → 题干在上一段，必须带上（否则这道题连问的是什么都不知道）
  let backward = 0
  while (start > 0 && backward < maxExtend && looksLikeOptions(paragraphs[start])) {
    start -= 1
    backward += 1
  }

  return {
    start,
    end,
    extendedForward: forward,
    extendedBackward: backward,
    text: paragraphs.slice(start, end).join("\n"),
  }
}
