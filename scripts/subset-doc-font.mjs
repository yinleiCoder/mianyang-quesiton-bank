// 给《系统与软件功能总结》PDF 用的中文字体子集。
//
// 为什么需要它：PyMuPDF 的 Story 会把 @font-face 里给的字体**整份**嵌进 PDF。
// Windows 自带的等线（DengXian）一份 16MB，正文与粗体两份就是 32MB——
// 一份 7 页的 PDF 撑到 23MB，发邮件都发不出去。
//
// 做法和 scripts/build-cjk-subset.mjs 一样：用 harfbuzz（subset-font）按**实际用到的字**
// 切一刀，产物通常只有一百来 KB。
//
// ⚠ 与 build-cjk-subset.mjs 的区别：**这里不做「连字符字宽归零」的手术**。
// 那条手术是给试卷 PDF 用的（为了让断行处引擎插的连字符隐形），
// 而本文件里 "mianyang-quesiton-bank" 这类带连字符的地址必须正常显示，
// 归零了就变成 "mianyangquesitonbank"。
//
// 用法：
//   node scripts/subset-doc-font.mjs <charset.txt> <out-dir>
//   charset.txt 里是本次文档用到的全部字符（纯文本，不换行也行）
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import subsetFont from "subset-font"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const [CHARSET_FILE, OUT_DIR] = process.argv.slice(2)

const WIN_FONTS = path.join(process.env.WINDIR || "C:\\Windows", "Fonts")
const SOURCES = [
  { src: path.join(WIN_FONTS, "Deng.ttf"), out: "doc-regular.ttf" },
  { src: path.join(WIN_FONTS, "Dengb.ttf"), out: "doc-bold.ttf" },
]

async function main() {
  if (!CHARSET_FILE || !existsSync(CHARSET_FILE)) {
    console.error("用法：node scripts/subset-doc-font.mjs <charset.txt> <out-dir>")
    process.exit(1)
  }
  const outDir = OUT_DIR || path.join(ROOT, ".tmp-doc-font")
  const charset = [...new Set((await readFile(CHARSET_FILE, "utf8")).replace(/\s/g, ""))]
  console.log(`字符集：${charset.length} 个字`)

  await mkdir(outDir, { recursive: true })
  for (const { src, out } of SOURCES) {
    if (!existsSync(src)) {
      console.warn(`  跳过 ${out}：找不到源字体 ${src}`)
      continue
    }
    const buf = await readFile(src)
    const sub = await subsetFont(buf, charset.join(""), { targetFormat: "sfnt" })
    await writeFile(path.join(outDir, out), sub)
    console.log(`  ${out}  ${Math.round(sub.length / 1024)} KB`)
  }
  console.log(`输出目录：${outDir}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
