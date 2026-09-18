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

// ---------- 按题切块，再打包成批 ----------
//
// 历史：这里原本是 `docxWindow(paragraphs, pageNo)` —— 以**第 pageNo 段**为起点开一个
// 5 段的窗口，再向两边扩展到题目边界。它治好了"切坏题"，但留下一个更贵的问题：
// **每段都开一个窗口，相邻窗口重叠 4/5**。一份 200 段的真题因此要调 200 次模型，
// 按实测每次 15~24 秒算，串行跑要 50 分钟以上 —— 使用者看到的就是"卡死"。
//
// 现在改成两步，切一次就定下来：
//   1) segmentQuestions：把段落切成"题块"（一道题的题干 + 它的选项/解析，直到下一道题的题干）；
//   2) docxBatches：把若干题块打包成"批"，一批 = 一次模型调用。
//
// 于是 200 段 → 约 60 个题块 → 约 12 批，调用数少一个数量级，而且**窗口之间不再重叠**。
// 因为每批都是完整题块的并集，"切坏题"在构造上就不可能发生。

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

// 一道新题的开头。**必须同时排除选项段**：卷面里"题干里带着 A. B."的排版会让一段
// 同时命中两个判据（见 test-docx-window 里的 falsePositive 提示），只按 looksLikeStem
// 切就会把一道题劈成两半 —— 而选项段绝对不可能是一道新题的开头。
function startsNewQuestion(p) {
  return looksLikeStem(p) && !looksLikeOptions(p)
}

/**
 * 把段落切成"题块"：每个块 = 一道题的题干 + 跟着的选项/解析段，直到下一道题的开头。
 * 返回 string[][]（保持原始段落，不丢任何一段）。
 */
export function segmentQuestions(paragraphs) {
  const blocks = []
  let cur = []
  for (const p of paragraphs) {
    if (cur.length > 0 && startsNewQuestion(p)) {
      blocks.push(cur)
      cur = []
    }
    cur.push(p)
  }
  if (cur.length > 0) blocks.push(cur)
  return blocks
}

/**
 * 把段落打包成"批"——一批 = 一次模型调用。
 *
 * 两个上限都要有：perBatch 限制**题数**（输出 token 与延迟的主要来源），
 * maxChars 限制**字数**（一道材料题可能独占几千字，只按题数打包会让某一批特别大）。
 * maxChars 只在不小于一块时才生效，所以超长的单块仍会自成一批而不是死循环。
 *
 * @returns [{ start, end, questions, text }]，start/end 是 0 基段落下标（end 不含）
 */
export function docxBatches(paragraphs, { perBatch = 5, maxChars = 6000 } = {}) {
  const blocks = segmentQuestions(paragraphs)
  const batches = []
  let cursor = 0 // 已消费的段落数，用来算 start/end
  let i = 0
  while (i < blocks.length) {
    const first = i
    let chars = 0
    while (i < blocks.length && i - first < perBatch) {
      const blockChars = blocks[i].reduce((n, p) => n + p.length + 1, 0)
      if (i > first && chars + blockChars > maxChars) break
      chars += blockChars
      i += 1
    }
    const paras = blocks.slice(first, i).flat()
    batches.push({
      start: cursor,
      end: cursor + paras.length,
      questions: i - first,
      text: paras.join("\n"),
    })
    cursor += paras.length
  }
  return batches
}
