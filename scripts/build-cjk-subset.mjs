// 一次性脚本：把一份中文字体切成「GB2312 子集」，产物提交进 public/fonts/。
//
// 为什么是子集而不是整包：Noto Sans SC 整包 10.5MB，试卷用字跑不出 GB2312（6763 汉字
// + 682 符号），子集后只有三分之一。为什么不做"按需子集"（导出时按本次文字切）：
// 那要么把整包塞进浏览器（10MB + 1.5MB WASM），要么让导出依赖网络——两条都比子集差。
//
// 为什么原字体不入库：10MB 只在这一步用一次，跟着仓库走没意义。产物入库是刻意的：
// 字体是"导出必须成功"的东西，不能挂在网络上下载（本仓踩过 CDN 可用性的坑）。
//
// 用法：
//   # 1. 取两份 OFL 授权的中文字体（Noto Sans SC，OFL 1.1；思源黑体同源可平替）。
//   #    静态 TTF 的地址用 Google Fonts 的 CSS 接口拿（老 UA 才会给 TTF 而不是 woff2）：
//   curl -s -H "User-Agent: Mozilla/4.0" "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700"
//   #    输出里两个 src 就是 400 / 700 的直链，各 curl -L -o 存下来。
//   # 2. 生成（产物写 public/fonts/，字符集清单写 lib/pdf-font-charset.js）
//   node scripts/build-cjk-subset.mjs NotoSansSC-Regular.ttf NotoSansSC-Bold.ttf
//
// 可变字体也能吃：源文件带 wght 轴时自动按每个字重钉住轴，静态文件则原样用。
//
// 字体缺字怎么办：跑一遍会在末尾列出「要了但字体里没有」的字。试卷里真出现这种字
// （生僻姓名字最常见），把它们加进 scripts/cjk-extra-chars.txt，重跑即可。
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import subsetFont from "subset-font"
// fontkit 是 CJS 包，没有 default 导出（`import fontkit from "fontkit"` 会直接报错）
import * as fontkit from "fontkit"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const [SRC_REGULAR, SRC_BOLD] = process.argv.slice(2)
const EXTRA_FILE = path.join(ROOT, "scripts", "cjk-extra-chars.txt")
const OUT_DIR = path.join(ROOT, "public", "fonts")
const CHARSET_FILE = path.join(ROOT, "lib", "pdf-font-charset.js")

// 两个字重各出一个文件：react-pdf 不像浏览器会自己合成粗体，卷头与题干的小标题
// 要真加粗就得真给一份粗体。两档都按同一套字符集切，避免"标题里某个字没字形"。
const WEIGHTS = [
  { key: "regular", wght: 400, file: "noto-sans-sc-regular.ttf", src: () => SRC_REGULAR },
  { key: "bold", wght: 700, file: "noto-sans-sc-bold.ttf", src: () => SRC_BOLD },
]

// GB2312 全集：符号区 0xA1A1~0xA9FE（、。〈〉±×÷≤≥ 这些都在这里，不是汉字区）
// + 一级汉字 0xB0A1~0xD7FE + 二级汉字 0xD8A1~0xF7FE。
// 用 TextDecoder('gbk') 解：Node 自带 full-icu，不用再引一张编码表。
//
// 落回私用区（U+E000~U+F8FF）的槽位要丢掉：GB2312 在这些位置是空位，GBK 把空位
// 映射成了私用区码点，解码不会失败、只是得到一个字体里永远没有的字。
function gb2312Chars() {
  const dec = new TextDecoder("gbk")
  const out = []
  for (let lead = 0xa1; lead <= 0xf7; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const s = dec.decode(new Uint8Array([lead, trail]))
      const cp = s.codePointAt(0)
      if (s === "�" || (cp >= 0xe000 && cp <= 0xf8ff)) continue
      out.push(s)
    }
  }
  return out
}

// GB2312 之外还要的：半角 ASCII、拼音（语文卷的注音）、通用标点里**看得见**的那些
// （• … ‘ ’ “ ” —— 现代文本天天用，GB2312 只有全角版）、①~⑳、几个白送的度量符号。
//
// 两条"别贪心"的经验，都是实测出来的：
//   · 拉丁扩展 A 只收拼音那几十个：中文字体只做拼音，Ą ć Ř ž 这类波兰/捷克字母本来
//     就没有，整个区块要下来会让缺字清单多出 80 个永远补不上的噪声。
//   · 通用标点只收可见段：U+2000~U+200F 是空格与方向标记、U+2060~U+206F 是格式化
//     控制符，字体里没有也不该有，要进来同样是噪声。
function extraVisibleChars() {
  const out = []
  for (let cp = 0x20; cp <= 0x7e; cp++) out.push(String.fromCodePoint(cp)) // ASCII 可打印
  for (let cp = 0xa1; cp <= 0xff; cp++) out.push(String.fromCodePoint(cp)) // 拉丁补充（去掉 NBSP）
  for (let cp = 0x2460; cp <= 0x2473; cp++) out.push(String.fromCodePoint(cp)) // ①~⑳
  out.push(...PINYIN)
  out.push("〇", "㎡", "㎏", "㎝", "㎜", "㎞", "℃")
  out.push(...PUNCT)
  return out
}

// 通用标点与数学符号：只收"中文字体普遍有、试卷真会用"的那些。摊开整个
// U+2010~U+205E 会带进 47 个印刷体冷门符号（‗ ⁊ ⁐ ⁛ …），它们永远补不上，
// 只会把缺字报告淹成噪声——报告一旦是噪声，就没人再看了。
// 这份名单是拿 Noto Sans SC 逐个试过的（只有 U+2044 分数斜杠、U+2216 集合减号没有，
// 两个都不收）。箭头、几何、数学符号大半在 GB2312 里，重复收一次也无害（会去重）。
const PUNCT = [
  ..."‐‑‒–—―‘’‚“”„†‡•‥…‰′″‹›※",
  ..."−∕≠≤≥∞≈∈∉∠∥∫∴∵",
  ..."○●□■☆★→←↑↓⇒⇔",
]

// 拼音：声调一律用**预组合**字符（ā 而不是 a + ˉ）。组合音标中文字体不做，
// 而输入法/导入文本产出的都是预组合，收这一份就够。
const PINYIN = [
  ..."āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüêńňǹ",
  ..."ĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛÜÊŃŇǸ",
]

// 额外的字：一份纯文本，一行一串（注释以 # 开头）。缺字时的唯一入口。
async function extraChars() {
  if (!existsSync(EXTRA_FILE)) return []
  const text = await readFile(EXTRA_FILE, "utf8")
  const body = text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("")
  return [...body.replace(/\s/g, "")]
}

function dedupe(list) {
  return [...new Set(list)].join("")
}

// ---------- 字体手术：把某个字的宽度改成 0 ----------
//
// 为什么需要动字体：react-pdf 的中文断行只能靠 hyphenationCallback 把汉字切成一个个
// "音节"，而排版引擎**每次在音节边界断行都会插一个连字符**（U+002D）。中文断行不该有
// 连字符，而引擎没有开关——它连宽度都写死成 5pt（@react-pdf/textkit 的 getNodes）。
//
// 所以换个角度：让那个连字符**看不见**。把 U+002D 的字宽改成 0，引擎照插不误，
// 但印出来是零宽的。正文里真的连字符（MY-2026-01 这种）在组装文字时统一换成
// U+2010（HYPHEN，宽度正常、字形几乎一样），所以不会被这个手术波及。
//
// 代价写清楚：从 PDF 里复制文字时，断行处会多出一个 '-'。这跟正常 PDF 里英文断词的
// 表现一致，比"整段中文不换行被裁掉"或者"每个字之间塞一个空格导致搜不到词"好得多。
const ZERO_WIDTH_CODEPOINTS = [0x2d]

function tableDir(buf) {
  const n = buf.readUInt16BE(4)
  const tables = {}
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16
    tables[buf.toString("ascii", o, o + 4)] = {
      checksumAt: o + 4,
      offset: buf.readUInt32BE(o + 8),
      length: buf.readUInt32BE(o + 12),
    }
  }
  return tables
}

// TTF 的校验和：按 4 字节大端求和（末尾不足补 0）
function tableChecksum(buf, offset, length) {
  let sum = 0
  for (let i = 0; i < length; i += 4) {
    const b = (buf[offset + i] ?? 0) * 0x1000000 + ((buf[offset + i + 1] ?? 0) << 16) + ((buf[offset + i + 2] ?? 0) << 8) + (buf[offset + i + 3] ?? 0)
    sum = (sum + b) >>> 0
  }
  return sum >>> 0
}

// 改 hmtx 里某个字形的 advanceWidth，并把 hmtx 的校验和、head 的 checkSumAdjustment 一起修好。
// 不修也能被 fontkit 读（它不校验），但留着一个校验和不对的文件是给后来人埋雷。
function zeroWidths(font, glyphIds) {
  const tables = tableDir(font)
  const numH = font.readUInt16BE(tables.hhea.offset + 34) // numberOfHMetrics
  for (const gid of glyphIds) {
    const at = tables.hmtx.offset + Math.min(gid, numH - 1) * 4
    font.writeUInt16BE(0, at)
  }
  font.writeUInt32BE(tableChecksum(font, tables.hmtx.offset, tables.hmtx.length), tables.hmtx.checksumAt)
  const headAdj = tables.head.offset + 8
  font.writeUInt32BE(0, headAdj)
  font.writeUInt32BE(tableChecksum(font, tables.head.offset, tables.head.length), tables.head.checksumAt)
  const total = tableChecksum(font, 0, font.length)
  font.writeUInt32BE((0xb1b0afba - total) >>> 0, headAdj)
}

async function main() {
  if (!SRC_REGULAR || !existsSync(SRC_REGULAR)) {
    console.error("用法：node scripts/build-cjk-subset.mjs <Regular.ttf> [Bold.ttf]")
    process.exit(1)
  }
  const charset = dedupe([...gb2312Chars(), ...extraVisibleChars(), ...(await extraChars())])
  console.log(`字符集：${[...charset].length} 个字`)

  // 先拿 fontkit 读源字体，确认它真的覆盖这些字——缺的字要显式报出来，
  // 否则 harfbuzz 会安静地跳过，导出的 PDF 里就是一个空白。
  const srcBuf = await readFile(SRC_REGULAR)
  const probe = fontkit.create(srcBuf)
  const hasWghtAxis = (probe.fvar?.axis ?? []).some((a) => a.axisTag === "wght")
  const missing = [...charset].filter((ch) => !probe.hasGlyphForCodePoint(ch.codePointAt(0)))
  if (missing.length) {
    console.warn(`⚠ 字体里没有这 ${missing.length} 个字：${missing.join("")}`)
    console.warn("  要收进导出结果，请把它们加进 scripts/cjk-extra-chars.txt 并换一份字体")
  }

  const covered = [...charset].filter((ch) => !missing.includes(ch)).join("")

  await mkdir(OUT_DIR, { recursive: true })
  for (const { wght, file, src } of WEIGHTS) {
    const file0 = src()
    if (!file0 || !existsSync(file0)) {
      console.warn(`  跳过 ${file}：没有给这个字重的源文件`)
      continue
    }
    const buf = await readFile(file0)
    const out = await subsetFont(buf, covered, {
      targetFormat: "sfnt",
      // 可变字体要钉住轴：react-pdf（fontkit）不吃可变轴，不钉的话每个字都按默认
      // 轴渲染，粗细全靠运气。静态字体没有轴，钉了 harfbuzz 会直接报错。
      ...(hasWghtAxis ? { variationAxes: { wght } } : {}),
    })
    // 子集出来之后再动字宽：先切后改，改的是一个我们完全掌握的小文件。
    const gids = ZERO_WIDTH_CODEPOINTS.map((cp) => {
      const g = fontkit.create(out).glyphForCodePoint(cp)
      return g?.id
    }).filter((id) => typeof id === "number")
    zeroWidths(out, gids)
    await writeFile(path.join(OUT_DIR, file), out)
    console.log(`  ${file}  ${Math.round(out.length / 1024)} KB  (wght=${wght}${hasWghtAxis ? ", 钉轴" : ", 静态源"})`)
  }

  // 手术自查：改完必须真读到 0（读不到就是 hmtx 位置算错了，那时断行的连字符会现形）
  const check = fontkit.create(await readFile(path.join(OUT_DIR, WEIGHTS[0].file)))
  for (const cp of ZERO_WIDTH_CODEPOINTS) {
    const w = check.glyphForCodePoint(cp)?.advanceWidth
    console.log(`  U+${cp.toString(16).toUpperCase().padStart(4, "0")} 字宽 = ${w}${w === 0 ? "" : "  ← 应为 0，手术没生效"}`)
  }

  // 字符集清单给浏览器端用：导出前拿它核对文字，缺字就提示，不做事后诸葛亮。
  const body = `// 本文件由 scripts/build-cjk-subset.mjs 生成，不要手改。
// public/fonts/ 下那两份子集字体覆盖的字符全集（GB2312 + ASCII + 通用标点 + 额外字）。
// 用途只有一个：导出 PDF 前核对，缺字时告诉用户缺哪几个，而不是导出后才发现空白。
export const PDF_FONT_CHARSET = ${JSON.stringify(covered)}
`
  await writeFile(CHARSET_FILE, body)
  console.log(`字符集清单：lib/pdf-font-charset.js`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
