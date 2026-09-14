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
