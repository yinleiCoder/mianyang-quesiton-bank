// 验证 Word 导入的切块与打包（lib/docx-client.js 的 segmentQuestions / docxBatches）。
//
// 起因：一份真实单招卷（docs/高三单招真题_修订后及答案.docx）按固定 5 段切窗时，
// 前几页就切出了"题干在窗口内、选项在窗口外"的残缺题——那种题在入库时
// 必然被 validate_question_content 判为「选择题至少需要 2 个选项」而失败。
//
// 后来发现更贵的问题：那种做法**每段开一个窗口、相邻重叠 4/5**，200 段的卷子要调 200 次模型，
// 串行 50 分钟以上（使用者看到的就是"卡死"）。现在改成"先按题切块、再把若干块打包成批"，
// 本文件同时守住两条线：**不许切坏题**，以及**批数要比段数少一个数量级**。
//
// 跑法：npm run test:docx（用真实 docx 做输入，不需要网络、不需要密钥、不花一分钱）

import fs from "node:fs"
import path from "node:path"
import { docxBatches, segmentQuestions, looksLikeOptions, looksLikeStem } from "@/lib/docx-client"

const FILE = path.resolve("docs/高三单招真题_修订后及答案.docx")

let failed = 0
function fail(msg) {
  console.error("✗ " + msg)
  failed++
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

// ---------- 2) 切块必须覆盖全部段落且不丢不重 ----------
console.log("\n— 切块 —")
const blocks = segmentQuestions(paragraphs)
const flat = blocks.flat()
if (flat.length === paragraphs.length) ok(`题块覆盖全部 ${paragraphs.length} 段，一段不多一段不少`)
else fail(`段落数对不上：切出 ${flat.length} 段，原文 ${paragraphs.length} 段`)
if (flat.every((p, i) => p === paragraphs[i])) ok("段落顺序与原文一致")
else fail("段落顺序被打乱了")
ok(`切成 ${blocks.length} 个题块（平均 ${(paragraphs.length / blocks.length).toFixed(1)} 段/块）`)

// ---------- 3) 批不能把一道题切成两半 ----------
// 与旧测试同一套判据：批的末尾是题干、而下一段是选项 → 选项被留在批外；
// 批的开头是选项、而上一段是题干 → 题干被留在批外。
console.log("\n— 批边界 —")
function endsMidQuestion(ps, start, end) {
  if (end >= ps.length) return false
  return looksLikeStem(ps[end - 1]) && looksLikeOptions(ps[end])
}
function startsMidQuestion(ps, start) {
  return start > 0 && looksLikeOptions(ps[start]) && looksLikeStem(ps[start - 1])
}

const batches = docxBatches(paragraphs)
let broken = 0
let overlap = 0
let covered = 0
let prevEnd = 0
for (const b of batches) {
  if (endsMidQuestion(paragraphs, b.start, b.end) || startsMidQuestion(paragraphs, b.start)) {
    broken++
    console.log(`    第 ${batches.indexOf(b) + 1} 批（段 ${b.start + 1}..${b.end}）被切断`)
  }
  if (b.start !== prevEnd) overlap++ // 批之间必须首尾相接，既不重叠也不留缝
  prevEnd = b.end
  covered += b.end - b.start
}

if (broken === 0) ok(`${batches.length} 批没有任何一批被题目边界切断`)
else fail(`有 ${broken} 批被切断（见上）`)
if (overlap === 0 && covered === paragraphs.length) ok("批之间首尾相接：不重叠、不留缝")
else fail(`批边界不连续：${overlap} 处错位，覆盖 ${covered}/${paragraphs.length} 段`)

// ---------- 4) 调用次数必须显著下降（这才是这次改动的意义） ----------
console.log("\n— 调用次数 —")
const oldCalls = paragraphs.length // 旧做法：每段一次
const ratio = oldCalls / batches.length
console.log(`旧：${oldCalls} 次调用（每段一次，相邻窗口重叠 4/5）`)
console.log(`新：${batches.length} 次调用（${(paragraphs.length / batches.length).toFixed(1)} 段/批）`)
if (ratio >= 5) ok(`调用次数降到 1/${ratio.toFixed(1)}`)
else fail(`调用次数只降到 1/${ratio.toFixed(1)}，收益不足（预期 ≥5×）`)

// 每批规模要可控：太大则单次输出容易截断，太小则又退回"调用次数多"
const sizes = batches.map((b) => b.end - b.start)
const chars = batches.map((b) => b.text.length)
console.log(
  `\n每批段数 ${Math.min(...sizes)}~${Math.max(...sizes)}，字数 ${Math.min(...chars)}~${Math.max(...chars)}`
)
if (Math.max(...chars) <= 6000 + 2000) ok("每批字数在上限附近之内（超长的单块会自成一批）")
else fail(`有批字数过大：${Math.max(...chars)}`)
if (batches.every((b) => b.questions >= 1)) ok("每批至少含一个题块")
else fail("出现了空批")

// 偏大的批要能一眼看见：批越大，一次输出被截断（模型 max output）的风险越高。
// 截断不会静默出错（parseOnePage 会抢救 JSON 并给每道题打 truncated 标记），
// 但教师得知道"这批末尾可能不全"，所以这里把离群的批列出来。
const big = batches
  .map((b, i) => ({ no: i + 1, ...b, chars: b.text.length }))
  .filter((b) => b.chars > 1500 || b.end - b.start > 40)
if (big.length === 0) {
  ok("没有明显偏大的批")
} else {
  console.log(`  （${big.length} 个偏大的批，截断风险较高，跑批时留意其 truncated 标记）`)
  for (const b of big) {
    console.log(`    第 ${b.no} 批：段 ${b.start + 1}..${b.end}（${b.end - b.start} 段 / ${b.chars} 字 / ${b.questions} 块）`)
  }
}

// ---------- 5) 抽查第一批，人眼确认切得对 ----------
console.log("\n— 抽查第 1 批 —")
console.log(`段 ${batches[0].start + 1}..${batches[0].end}，含 ${batches[0].questions} 个题块`)
batches[0].text
  .split("\n")
  .forEach((l) => console.log("   " + l.slice(0, 76).replace(/\t/g, " ␉ ")))

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
