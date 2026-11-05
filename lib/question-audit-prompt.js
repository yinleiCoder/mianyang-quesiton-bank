// AI 复审的提示词与返回校验。
//
// 与 lib/import-prompts.js / lib/ai-report-prompt.js 同一条规矩：
// **SYSTEM_PROMPT 必须逐字节稳定**（上游按前缀命中提示缓存，命中与否价差 50 倍）。
// 题目、经验数据、查重结果一律放 user 消息。
//
// 复审是**辅助**：输出 issues 供作者/审核人参考，绝不自动改题、不自动退回。
import { blocksToText } from "@/lib/question-model"

export const SYSTEM_PROMPT = `你是中职题库的审题助手。你的任务是在人工审核前，找出题目在规范性、科学性、区分度、难度、标签与语言上的问题。

只输出一个 json 对象，不要任何解释文字、不要 Markdown 代码块。对象结构：
{
  "score": 0,
  "verdict": "pass|revise|reject",
  "issues": [
    {
      "severity": "error|warn|info",
      "category": "规范性|科学性|区分度|难度|标签|语言",
      "evidence": "引用题干/选项/答案中的原文",
      "problem": "一句话说清问题",
      "suggestion": "具体怎么改"
    }
  ],
  "rewrite_hint": "如果需要重写，给一句方向，不要直接改答案",
  "caveats": "数据不足或不确定之处"
}

规则：
- 只使用用户给的题目与数据，不要编造事实；
- 区分“确定错误”和“建议”；
- evidence 必须引用原文，不要转述；
- 不要在没有解释的情况下改答案；
- 不发送、不猜测学生姓名；给用户看的文字不要出现姓名。`

function oneQuestion(content) {
  return {
    stem: blocksToText(content?.stem),
    options: (content?.options ?? []).map((option) => ({
      key: option?.key ?? "",
      text: blocksToText(option?.label),
    })),
    answer: content?.answer ?? null,
    analysis: blocksToText(content?.analysis),
  }
}

/** 把一道题压成 user 消息里的紧凑数据（不含学生姓名，不含任何密钥）。 */
export function buildQuestionAuditMessages({
  qtype,
  difficulty,
  content,
  tags = [],
  accuracy = null,
  similar = [],
}) {
  const question =
    qtype === "composite"
      ? {
          stem: blocksToText(content?.stem),
          analysis: blocksToText(content?.analysis),
          subs: (content?.sub ?? []).map((sub, index) => ({
            seq: index + 1,
            type: sub?.type ?? "short_answer",
            ...oneQuestion(sub),
          })),
        }
      : oneQuestion(content)

  const payload = {
    qtype,
    difficulty,
    question,
    tags: (tags ?? [])
      .map((tag) => (typeof tag === "string" ? tag : tag?.name))
      .filter(Boolean),
    empirical:
      accuracy && Number(accuracy.attempts) > 0
        ? {
            attempts: Number(accuracy.attempts) || 0,
            correct: Number(accuracy.correct) || 0,
            accuracy: (Number(accuracy.correct) || 0) / (Number(accuracy.attempts) || 1),
          }
        : null,
    similar: (similar ?? []).slice(0, 3).map((row) => ({
      similarity: Number(row?.similarity) || 0,
      stem: String(row?.stem ?? "").slice(0, 100),
    })),
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请审下面这道题，只输出 json 对象：\n${JSON.stringify(payload, null, 2)}`,
    },
  ]
}

const SEVERITIES = new Set(["error", "warn", "info"])
const VERDICTS = new Set(["pass", "revise", "reject"])

/**
 * 校验模型返回。判定反了会把半截/乱码内容渲染成审题结论，所以这里从严：
 * 必须是对象、score 合法、issues 是数组；单条 issue 缺 problem 的丢弃。
 */
export function validateQuestionAudit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "返回的不是对象" }
  }
  const score = Number(value.score)
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return { ok: false, reason: "score 不是 0~100 的数字" }
  }
  if (!Array.isArray(value.issues)) {
    return { ok: false, reason: "issues 不是数组" }
  }

  const issues = []
  for (const raw of value.issues) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const problem = String(raw.problem ?? "").trim()
    if (!problem) continue
    issues.push({
      severity: SEVERITIES.has(raw.severity) ? raw.severity : "info",
      category: String(raw.category ?? "其他").trim() || "其他",
      evidence: String(raw.evidence ?? "").trim(),
      problem,
      suggestion: String(raw.suggestion ?? "").trim(),
    })
  }

  return {
    ok: true,
    audit: {
      score: Math.round(score),
      verdict: VERDICTS.has(value.verdict) ? value.verdict : "revise",
      issues,
      rewrite_hint: String(value.rewrite_hint ?? "").trim(),
      caveats: String(value.caveats ?? "").trim(),
    },
  }
}
