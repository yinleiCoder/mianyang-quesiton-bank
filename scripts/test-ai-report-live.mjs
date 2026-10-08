// 用**真的 DeepSeek** 跑一次班级 AI 分析，看提示词与返回结构到底行不行。
//
// 跑法（密钥只走环境变量，**绝不写进文件、绝不进仓库**）：
//   PowerShell:  $env:DEEPSEEK_API_KEY='sk-...'; node scripts/test-ai-report-live.mjs <payload.json> [复习进度]
//   bash:        DEEPSEEK_API_KEY=sk-... node scripts/test-ai-report-live.mjs <payload.json> [复习进度]
//
// payload.json 从服务端取：`select class_ai_payload(<paper>, <class>)` 里的 payload。
// 网页上点"生成"走的是同一条路（lib/ai-report-prompt.js + lib/deepseek.js 的 callChat），
// 差别只有一个在浏览器里、一个在 node 里 —— 所以这个脚本能当"提示词改动的回归工具"用。
//
// 想换模型：DEEPSEEK_MODEL=deepseek-v4-pro
import fs from "node:fs"
import { callChat, salvageJson, DEFAULT_MODEL } from "../lib/deepseek.js"
import { buildAiReportMessages, validateAiReport, SYSTEM_PROMPT } from "../lib/ai-report-prompt.js"

const [file, note = ""] = process.argv.slice(2)
if (!file) {
  console.error("用法：DEEPSEEK_API_KEY=sk-... node scripts/test-ai-report-live.mjs <payload.json> [复习进度]")
  process.exit(2)
}
const apiKey = process.env.DEEPSEEK_API_KEY
if (!apiKey) {
  console.error("缺 DEEPSEEK_API_KEY 环境变量（不要把密钥写进文件）")
  process.exit(2)
}

const payload = JSON.parse(fs.readFileSync(file, "utf8"))
const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL
console.log(
  `payload：${payload.questions?.length ?? 0} 题 · 参加 ${payload.class?.participants ?? "?"}/${
    payload.class?.student_count ?? "?"
  } 人 · 练习节点 ${payload.practice?.weak_nodes?.length ?? 0} 个` +
    (note ? ` · 复习进度「${note}」` : " · 未填复习进度")
)

const messages = buildAiReportMessages(payload, { progressNote: note })
console.log(`prompt：system ${SYSTEM_PROMPT.length} 字（固定）+ user ${JSON.stringify(messages[1]).length} 字`)

const t0 = Date.now()
const res = await callChat({ messages, apiKey, model, maxTokens: 8000 })
console.log(
  `模型 ${res.model} · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s · ` +
    `tokens ${res.usage?.prompt_tokens ?? "?"}+${res.usage?.completion_tokens ?? "?"} · finish=${res.finishReason}`
)

const obj = salvageJson(res.content)
const check = validateAiReport(obj)
if (!check.ok) {
  console.error(`✗ 校验不通过：${check.reason}`)
  console.error("—— 模型原文（前 1200 字）——\n" + String(res.content).slice(0, 1200))
  process.exit(1)
}
console.log("✓ 结构校验通过\n" + JSON.stringify(obj, null, 2))
