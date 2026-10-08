// 试卷导出 PDF 的自检：在 node 里把一份**真实形状的**试卷快照渲染成 PDF，
// 再用 pdfjs 把文字抽回来核对。运行：npm run test:pdf
//
// 为什么值得这么测：这条链路最容易出的三类事故，都是"看起来成功、文件是坏的"——
//   1. 中文字形没嵌进去 → PDF 能打开，字是空白（只有把文字抽回来才看得见）
//   2. 正卷里混进了答案 → 网页上不会，PDF 里可能（这是安全边界，必须断言）
//   3. 图片没上 → 打开才发现整页缺图
// 另外顺带钉住纯函数：图片缩放、缺字检查、卷面遍历。
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import React from "react"
import { renderToFile } from "@react-pdf/renderer"
import { PaperPdfDocument } from "@/components/papers/paper-pdf-document"
import { registerPdfFonts, missingGlyphs } from "@/lib/pdf-fonts"
import { collectMediaKeys, collectText, imageBox, imageBytesKind } from "@/lib/pdf-prep"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, ".next", "pdf-test")

let failed = 0
function ok(cond, label) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`)
  if (!cond) failed++
}

// ---- 造一张真 PNG（400×200），用来验"图片能嵌进去、宽高按比例" ----
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 真彩色 RGB
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = 40
      raw[o + 1] = 120
      raw[o + 2] = 200
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const T = (text) => ({ t: "text", text })
const IMG = (key, alt = "示意图") => ({ t: "media", kind: "image", key, alt })

// 一份把各种坑都摆上的卷子：中文长段落（验断行）、[[图1]] 占位（导入态的残留）、
// 真图片、长短选项混排、复合题、音频块、答案与解析。
const SNAPSHOT = {
  title: "2026 年职教高考语文模拟试卷（第一套）",
  exam_name: "绵阳市中职学校联合考试",
  subject_label: "语文",
  total_score: 120,
  duration_minutes: 150,
  header: { code: "MY-2026-01", show_candidate_bar: true },
  instructions: [T("1. 答题前请将姓名、学号填写在密封线内。\n2. 选择题用 2B 铅笔填涂，非选择题用 0.5mm 黑色签字笔书写。")],
  sections: [
    {
      id: "s1",
      title: "单项选择题",
      instruction: "每小题只有一个正确选项。",
      score_mode: "each",
      score_each: 3,
      items: [
        {
          id: "q1",
          seq: 1,
          qtype: "single_choice",
          score: 3,
          content: {
            stem: [
              T(
                "下列词语中加点字的读音完全正确的一项是。这道题的题干故意写得很长，用来验证中文长段落能不能自动断行——中文字之间没有空格，如果排版引擎按英文的规矩只在空格处断行，这一整段就会冲出纸面被裁掉。"
              ),
              IMG("qbank/2026/demo-1.png"),
            ],
            options: [
              { key: "A", label: [T("锲而不舍（qiè）")] },
              { key: "B", label: [T("强词夺理（qiáng）")] },
              { key: "C", label: [T("味同嚼蜡（jiáo）")] },
              { key: "D", label: [T("咬文嚼字（jué）")] },
            ],
            answer: { keys: ["C"] },
            analysis: [T("“嚼”在“味同嚼蜡”中读 jiáo，表示像吃蜡一样没有味道。")],
          },
        },
        {
          id: "q2",
          seq: 2,
          qtype: "single_choice",
          score: 3,
          content: {
            stem: [
              T("根据图意选择正确的一项（导入态里图还没补，题干留着占位）：[[图1]]"),
              // 取不到的图（images 里没有这个 key）：应当退化成一行说明，而不是让整份导出失败
              IMG("qbank/取不到的图.png", "取不到的图"),
            ],
            options: [
              { key: "A", label: [T("甲")] },
              { key: "B", label: [T("乙")] },
              {
                key: "C",
                label: [T("这一项特别长，超过了十四个字，按卷面口径应该自己独占一行而不是和别人挤在半边")],
              },
              { key: "D", label: [T("丁")] },
            ],
            answer: { keys: ["A"] },
          },
        },
      ],
    },
    {
      id: "s2",
      title: "填空题",
      score_mode: "each",
      score_each: 2,
      items: [
        {
          id: "q3",
          seq: 3,
          qtype: "fill_blank",
          score: 6,
          score_units: [2, 2, 2],
          content: {
            stem: [T("《劝学》中“青，取之于蓝，而青于蓝”一句，说明学习可以使人______。")],
            answer: { values: ["提高", "超越", "进步"] },
            analysis: [T("三个空的答案顺序可以互换，阅卷时按点给分。")],
          },
        },
        {
          id: "q4",
          seq: 4,
          qtype: "true_false",
          score: 2,
          content: { stem: [T("“人生自古谁无死，留取丹心照汗青”出自文天祥的《过零丁洋》。")], answer: { value: true } },
        },
      ],
    },
    {
      id: "s3",
      title: "材料分析题",
      score_mode: "each",
      score_each: 8,
      items: [
        {
          id: "q5",
          seq: 5,
          qtype: "composite",
          score: 16,
          content: {
            stem: [T("阅读下面的材料，完成后面的题目。"), { t: "media", kind: "audio", key: "qbank/2026/demo.mp3", alt: "朗读音频" }],
            sub: [
              {
                type: "fill_blank",
                content: { stem: [T("（1）材料中提到的“三顾茅庐”说的是______。")], answer: { values: ["刘备三次拜访诸葛亮"] } },
              },
              {
                type: "short_answer",
                content: {
                  stem: [T("（2）结合材料，谈谈你对工匠精神的理解。")],
                  answer: { samples: ["工匠精神是对产品精雕细琢、追求极致的职业态度。", "它要求从业者耐得住寂寞，在重复中打磨技艺。"] },
                },
              },
            ],
            analysis: [T("本题综合考查概括与表达能力，评分时按点给分。")],
          },
        },
      ],
    },
  ],
}

function images() {
  const png = makePng(400, 200)
  return new Map([["qbank/2026/demo-1.png", { src: `data:image/png;base64,${png.toString("base64")}`, width: 400, height: 200 }]])
}

// 正文盒子的右边界：A4 宽 595.28 − 左右各 40 的内边距。文字一旦越过它，
// 就是"没换行、被裁掉了"——这是中文排版最容易出、也最不显眼的故障。
const RIGHT_EDGE = 595.28 - 40 + 2
// 行首禁则里最硬的两个：句号、逗号
const BAD_LINE_START = new Set("。，、；：？！）")

async function extract(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await (await import("node:fs/promises")).readFile(file)) }).promise
  const pages = []
  const lines = []
  let images = 0
  const OPS = pdfjs.OPS
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    pages.push(tc.items.map((it) => it.str).join(""))
    // 按 y 坐标把文字碎片归成"行"，用来验换行与行首禁则
    const byLine = new Map()
    for (const it of tc.items) {
      if (!it.str.trim()) continue
      const y = Math.round(it.transform[5])
      if (!byLine.has(y)) byLine.set(y, [])
      byLine.get(y).push(it)
    }
    for (const group of byLine.values()) {
      group.sort((a, b) => a.transform[4] - b.transform[4])
      lines.push({
        first: group[0].str[0],
        right: Math.max(...group.map((it) => it.transform[4] + it.width)),
        text: group.map((it) => it.str).join(""),
      })
    }
    const ops = await page.getOperatorList()
    images += ops.fnArray.filter((f) => f === OPS.paintImageXObject || f === OPS.paintImageXObjectRepeat).length
  }
  return { pages, lines, images }
}

async function main() {
  await mkdir(OUT, { recursive: true })

  console.log("\n纯函数")
  ok(JSON.stringify(imageBox(400, 200)) === '{"width":400,"height":200}', "小图不放大（只缩不放）")
  ok(JSON.stringify(imageBox(1600, 800)) === '{"width":420,"height":210}', "大图按比例缩到宽上限")
  ok(JSON.stringify(imageBox(200, 4000)) === '{"width":16,"height":320}', "竖图受高度上限约束")
  ok(missingGlyphs("中文 abc，。").length === 0, "常用字不缺")
  ok(missingGlyphs("陈𠮷").join("") === "𠮷", "超出 GB2312 的字被认出来")
  ok(collectMediaKeys(SNAPSHOT).join(",") === "qbank/2026/demo-1.png,qbank/取不到的图.png", "只收图片、按出现顺序去重")
  ok(collectText(SNAPSHOT).includes("下列词语"), "文字收集覆盖题干")
  // 图片字节嗅探：认不出来的必须在抓取阶段拦下，否则渲染阶段会连累整份导出。
  // webp 那条是真踩过的坑——展示地址默认带 format,webp，而 react-pdf 不认 webp。
  ok(imageBytesKind(makePng(4, 4)) === "png", "认得 png")
  ok(imageBytesKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) === "jpeg", "认得 jpg")
  ok(imageBytesKind(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) === "gif", "认得 gif")
  ok(imageBytesKind(new TextEncoder().encode("<svg xmlns=...")) === "svg", "认得 svg")
  ok(
    imageBytesKind(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])) === "unknown",
    "webp 被认出来（=会被拦下，退化成一行说明）"
  )
  ok(imageBytesKind(new TextEncoder().encode("<html><body>404")) === "unknown", "HTML 错误页被认出来")

  // 取图地址必须是 raw 档（只缩放）：默认档带 format,webp，reace-pdf 不认
  process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST = "oss.test"
  const { mediaUrl } = await import("@/lib/oss-url")
  const rawUrl = mediaUrl("qbank/a.png", { width: 1600, raw: true })
  ok(rawUrl === "https://oss.test/qbank/a.png?x-oss-process=image/resize,w_1600", `raw 档只缩放不转格式（${rawUrl}）`)
  ok(mediaUrl("qbank/a.png", { width: 720 }).includes("format,webp"), "默认档仍然是 webp（网页显示没受影响）")
  delete process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST
  // 用只在解析里出现的那句话判，不用选项文字——选项本来就属于正卷
  ok(!collectText(SNAPSHOT).includes("表示像吃蜡一样"), "正卷口径不含答案与解析")
  ok(collectText(SNAPSHOT, { withAnswers: true }).includes("表示像吃蜡一样"), "答案版口径收解析")

  await registerPdfFonts({ fontDir: path.join(ROOT, "public", "fonts") })

  for (const mode of ["paper", "answers"]) {
    const file = path.join(OUT, `${mode}.pdf`)
    await renderToFile(React.createElement(PaperPdfDocument, { snapshot: SNAPSHOT, mode, images: images() }), file)
    const { size } = await (await import("node:fs/promises")).stat(file)
    const { pages, lines, images: imgCount } = await extract(file)
    const text = pages.join("\n")

    console.log(`\n${mode === "paper" ? "正卷" : "参考答案"}（${pages.length} 页，${Math.round(size / 1024)} KB）`)
    ok(pages.length >= 1 && pages.every((p) => p.trim().length > 0), "每页都有文字（没有空白页）")
    ok(!text.includes("�"), "抽回的文本没有乱码")
    ok(text.includes("下列词语中加点字的读音"), "中文题干完整落在 PDF 里")
    ok(text.includes("职教高考联盟"), "页脚署名在")
    ok(text.includes("第 1 /"), "页码在")
    ok(imgCount >= 1, "题干里的图片被嵌进 PDF")
    ok(text.includes("［本题含音频"), "音频块退化成一行说明而不是消失")
    ok(text.includes("［图片：取不到的图未能载入］"), "取不到的图退化成一行说明")
    ok(text.includes("[[图1]]") || text.includes("图1"), "[[图N]] 占位原样保留（提醒补图）")
    // 下面两个 ‑ 是 U+2011（不是 U+2010，也不是减号）。这几个字符长得一模一样，
    // 改这行时请核对码点，否则会得到一个"看起来对但永远不过"的断言。
    ok(text.includes("MY‑" + "2026" + "‑" + "01"), "正文里的连字符换成了同宽的 U+2011（不会被隐形）")
    ok(!text.includes("MY-2026"), "正文里没有留下会被隐形的 U+002D")

    // 换行：中文长段落必须真的折行，且任何一行都不能越过右边界。
    // 这两条是整个导出里最容易悄悄坏掉的地方——不换行的 PDF 照样打得开，
    // 只是文字冲出去被裁掉，肉眼扫一眼还以为是排版风格。
    const badRight = lines.filter((l) => l.right > RIGHT_EDGE)
    ok(lines.length > 12, `文字确实折成了多行（共 ${lines.length} 行）`)
    ok(badRight.length === 0, `没有一行越过右边界${badRight.length ? `（越界 ${badRight.length} 行，如「${badRight[0].text.slice(0, 24)}」）` : ""}`)
    const badStart = lines.filter((l) => BAD_LINE_START.has(l.first))
    ok(badStart.length === 0, `没有一行以句读开头（行首禁则）${badStart.length ? `：${badStart.map((l) => l.text.slice(0, 12)).join(" / ")}` : ""}`)

    if (mode === "paper") {
      ok(!text.includes("正确答案"), "正卷不含答案")
      ok(!text.includes("解析"), "正卷不含解析")
      ok(!text.includes("分数构成"), "正卷不含分数速查表")
    } else {
      ok(text.includes("正确答案"), "答案版有答案")
      ok(text.includes("评分标准"), "答案版有给分点")
      ok(text.includes("分数构成"), "答案版卷末有分数速查表")
      ok(text.includes("参考答案"), "页脚标了参考答案")
    }
  }

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}（产物在 .next/pdf-test/）`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
