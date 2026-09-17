// 验证 docx 取窗的边界对齐（lib/docx-client.js 的 docxWindow）。
//
// 起因：一份真实单招卷（docs/高三单招真题_修订后及答案.docx）按固定 5 段切窗时，
// 前几页就切出了"题干在窗口内、选项在窗口外"的残缺题——那种题在入库时
// 必然被 validate_question_content 判为「选择题至少需要 2 个选项」而失败。
//
// 跑法：node --import ./scripts/alias-loader.mjs scripts/test-docx-window.mjs
// 用真实的 docx 做输入，不需要网络、不需要密钥、不花一分钱。

import fs from "node:fs"
import path from "node:path"
import { docxWindow, looksLikeOptions, looksLikeStem } from "@/lib/docx-client"

const FILE = path.resolve("docs/高三单招真题_修订后及答案.docx")

function fail(msg) {
  console.error("✗ " + msg)
  process.exitCode = 1
}
function ok(msg) {
  console.log("✓ " + msg)
}

const mammoth = await import("mammoth")
const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(FILE) })
// 与 lib/docx-client.js 的 extractDocx 完全同口径：按行切、去空行
const paragraphs = value
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

console.log(`文档：${path.basename(FILE)}，${paragraphs.length} 段\n`)

// ---------- 1) 判据函数自身的正确性 ----------
console.log("— 判据 —")
const optionSample = paragraphs.find((p) => looksLikeOptions(p))
const stemSample = paragraphs.find((p) => looksLikeStem(p))
if (optionSample) ok(`选项段判据命中：「${optionSample.slice(0, 46)}…」`)
else fail("选项段判据一条都没命中——判据写错了")
if (stemSample) ok(`题干段判据命中：「${stemSample.slice(0, 40)}…」`)
else fail("题干段判据一条都没命中")
// 反向：题干不该被判成选项段
const falsePositive = paragraphs.filter((p) => !looksLikeOptions(p) === false && looksLikeStem(p) && looksLikeOptions(p))
if (falsePositive.length > 0) {
  console.log(`  （提示：${falsePositive.length} 段同时像题干和选项，多见于"题干里带着 A. B."的排版）`)
}

// ---------- 2) 旧窗口 vs 新窗口 ----------
console.log("\n— 逐页对比（旧 = 固定 5 段，新 = 边界对齐）—")
let oldBroken = 0
let newBroken = 0
const problems = []

// 一批内容是否"自洽"：以题干收尾却没有后续选项段时视为被切断
function endsMidQuestion(ps, start, end) {
  if (end >= ps.length) return false
  const last = ps[end - 1]
  // 末尾是题干、而下一段是选项 → 这道题的选项被切在窗口外
  return looksLikeStem(last) && looksLikeOptions(ps[end])
}
function startsMidQuestion(ps, start) {
  return start > 0 && looksLikeOptions(ps[start]) && looksLikeStem(ps[start - 1])
}

for (let page = 1; page <= paragraphs.length; page++) {
  const oS = Math.max(0, page - 1)
  const oE = Math.min(paragraphs.length, page + 4)
  const win = docxWindow(paragraphs, page)
  if (endsMidQuestion(paragraphs, oS, oE) || startsMidQuestion(paragraphs, oS)) oldBroken += 1
  if (endsMidQuestion(paragraphs, win.start, win.end) || startsMidQuestion(paragraphs, win.start)) {
    newBroken += 1
    problems.push({ page, ...win })
  }
}

console.log(`旧切法：${oldBroken} / ${paragraphs.length} 页的窗口被题目边界切断`)
console.log(`新切法：${newBroken} / ${paragraphs.length} 页被切断`)

// ---------- 3) 具体看曾经失败的三页 ----------
console.log("\n— 当初真正出错的三页 —")
for (const page of [4, 5, 7]) {
  const win = docxWindow(paragraphs, page)
  const oS = Math.max(0, page - 1)
  const oE = Math.min(paragraphs.length, page + 4)
  console.log(`\n第 ${page} 页`)
  console.log(`  旧：段 ${oS + 1}..${oE}` + (endsMidQuestion(paragraphs, oS, oE) ? "  ← 末尾题干被切，选项在外" : ""))
  console.log(`  新：段 ${win.start + 1}..${win.end}` + (win.extendedBackward ? `  ← 向前补了 ${win.extendedBackward} 段取回题干` : "") + (win.extendedForward ? `  ← 向后补了 ${win.extendedForward} 段取回选项` : ""))
  win.text.split("\n").forEach((l) => console.log("     " + l.slice(0, 78).replace(/\t/g, " ␉ ")))
}

// ---------- 结论 ----------
console.log("\n— 结论 —")
if (newBroken === 0) ok("新切法下没有任何窗口被题目边界切断")
else fail(`仍有 ${newBroken} 页被切断（见上）`)
if (oldBroken > 0) ok(`旧切法确实会切坏 ${oldBroken} 页——这就是那 4 道题入库失败的结构性原因之一`)

// 窗口不能无限膨胀：平均长度要可控，否则每次调用都在烧 token
const avgOld = 5
const avgNew = paragraphs.reduce((a, _, i) => a + (docxWindow(paragraphs, i + 1).end - docxWindow(paragraphs, i + 1).start), 0) / paragraphs.length
console.log(`\n平均窗口：旧 ${avgOld} 段 → 新 ${avgNew.toFixed(2)} 段（膨胀 ${((avgNew / avgOld - 1) * 100).toFixed(1)}%）`)
if (avgNew > avgOld * 1.6) fail("窗口膨胀过多，会显著抬高解析费用")
else ok("窗口膨胀在可接受范围内")
