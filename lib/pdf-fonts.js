// 导出 PDF 的字体：登记 + 缺字检查。
//
// 中文在 react-pdf 里**必须内嵌字体**——浏览器能用系统字体是因为排版交给浏览器，
// 而 react-pdf 自己排版、自己写 PDF，字体不带进去就是一片空白。
// 字体是构建期切好的 GB2312 子集（scripts/build-cjk-subset.mjs），产物在 public/fonts/。
//
// 动态 import：不点导出就不加载 react-pdf，字体文件也是第一次渲染时才去取。
import { PDF_FONT_CHARSET } from "@/lib/pdf-font-charset"

export const CJK_FONT = "CJK"

// 汉字与中文标点（含全角区）。只有含这些字的"词"才需要切音节。
const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯　-〿]/
// 行首禁则：这些字不能出现在一行的开头（标点在行首是中文排版的硬禁忌）
const NO_LINE_START = new Set("。，、；：？！）］｝》」』】〕〉…—～·%‰℃°′″")
// 行尾禁则：这些字不能落在一行的末尾
const NO_LINE_END = new Set("（［｛《「『【〔〈")

// 把"一个词"切成若干个可以断行的音节。react-pdf 只会按空格切词，中文没有空格，
// 结果是整段中文**根本不换行**、直接冲出纸面被裁掉——这个回调是唯一的解法。
//
// 三件事同时在这里完成：
//   1. 汉字逐字成音节（汉字之间断行是合法的）
//   2. 连续的西文/数字抱成一团（"Excel" 不能被拆成 Ex-cel）
//   3. 行首/行尾禁则：断行点只可能落在音节边界，所以把不该分开的字**粘进同一个音节**
//      —— "的。" 是一个音节，于是 "。" 永远不会跑到下一行开头。
export function syllablesFor(word) {
  if (!CJK.test(word)) return [word]
  const parts = []
  const push = (piece) => {
    const last = parts[parts.length - 1]
    if (last && (NO_LINE_START.has(piece) || NO_LINE_END.has(last[last.length - 1]))) {
      parts[parts.length - 1] = last + piece
      return
    }
    parts.push(piece)
  }
  let latin = ""
  for (const ch of word) {
    if (CJK.test(ch)) {
      if (latin) push(latin), (latin = "")
      push(ch)
    } else {
      latin += ch
    }
  }
  if (latin) push(latin)
  return parts
}

let registered = false

// fontDir 留了个口子：浏览器传默认值（public/ 的静态路径），Node 端渲染测试传本地目录。
export async function registerPdfFonts({ fontDir = "/fonts" } = {}) {
  if (registered) return
  const { Font } = await import("@react-pdf/renderer")
  Font.register({
    family: CJK_FONT,
    fonts: [
      { src: `${fontDir}/noto-sans-sc-regular.ttf`, fontWeight: 400 },
      { src: `${fontDir}/noto-sans-sc-bold.ttf`, fontWeight: 700 },
    ],
  })
  Font.registerHyphenationCallback(syllablesFor)
  registered = true
}

const COVERED = new Set(PDF_FONT_CHARSET)

// 缺字检查：子集字体装不下 GB2312 之外的字，缺的那个字在 PDF 里就是空白——
// 与其让用户对着空白猜，不如导出前就说清楚缺哪几个，并告诉他去哪补。
// 空白字符不算缺（换行、制表、零宽都不该有字形）。
export function missingGlyphs(text) {
  const miss = new Set()
  for (const ch of String(text ?? "")) {
    if (/\s/.test(ch)) continue
    if (!COVERED.has(ch)) miss.add(ch)
  }
  return [...miss]
}
