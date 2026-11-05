// 审题预检（纯函数，可单测）。
//
// 两个原则：
//   1) **只提示，不改内容**：输出是给作者/审核人看的清单，最终决定仍由人做；
//   2) **结构校验复用落库那一套**：validateContent 与数据库契约逐条对齐，
//      这里不再抄一遍，避免"预检说没问题、保存却被拒"。
//
// 输入可以是编辑器的 draft（内部态）或已落库的 content（审核详情）；
// 两者都支持，审核页不需要再构造一份编辑器状态。
import {
  blocksToText,
  fromContent,
  serializeContent,
  validateContent,
} from "@/lib/question-model"

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 }

function issue(severity, category, problem, suggestion, extra = {}) {
  return { severity, category, problem, suggestion, ...extra }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function optionTexts(content) {
  return asArray(content?.options).map((option) => blocksToText(option?.label).trim())
}

function correctKeys(content) {
  return content?.answer?.type === "choice" ? asArray(content.answer.keys) : []
}

// 本题 + 复合题各子题，统一成同一套检查的输入
function questionUnits(qtype, content) {
  if (qtype !== "composite") return [{ label: "本题", content }]
  return asArray(content?.sub).map((sub, index) => ({
    label: `子题 ${index + 1}`,
    content: sub,
  }))
}

/**
 * 审一道题。
 *
 * @param {object} input
 * @param {object} [input.draft] 编辑器的内部草稿（优先）
 * @param {string} [input.qtype]
 * @param {number} [input.difficulty]
 * @param {object} [input.content] 已落库的内容（审核详情用）
 * @param {Array} [input.tags] 标签（对象或字符串都行）
 * @param {boolean} [input.hasNode] 是否选了归属科目（编辑页传）
 * @param {Array} [input.similar] find_similar_questions 的行
 * @param {object} [input.accuracy] { attempts, correct }
 * @returns {{score:number,grade:string,verdict:string,issues:Array,stats:object}}
 */
export function auditQuestion({
  draft,
  qtype,
  difficulty,
  content,
  tags = [],
  hasNode,
  similar = [],
  accuracy = null,
} = {}) {
  const d = draft ?? (qtype && content ? fromContent(qtype, difficulty, content, tags) : null)
  const q = qtype ?? d?.qtype ?? "single_choice"
  const c = content ?? (d ? serializeContent(d) : null)
  const issues = []
  let critical = false

  // ---------- 1) 结构：与落库同一套校验 ----------
  if (d) {
    for (const error of validateContent(d, { requireTags: false })) {
      issues.push(issue("error", "规范性", error, "按提示修正后再提交"))
    }
  } else if (!c) {
    issues.push(issue("error", "规范性", "没有可审的题目内容", "先把题干与作答部分填完"))
  }
  if (asArray(tags).length === 0) {
    issues.push(issue("warn", "标签", "还没有打知识点标签", "至少打 1 个标签，便于组卷与学情分析"))
  }
  if (hasNode === false) {
    issues.push(issue("warn", "规范性", "还没有选择归属科目", "选择科目节点后再保存"))
  }

  // ---------- 2) 逐题质量检查 ----------
  for (const unit of questionUnits(q, c)) {
    const texts = optionTexts(unit.content)
    const keys = correctKeys(unit.content)
    const optionKeys = asArray(unit.content?.options).map((option) => option?.key)
    const where = unit.label === "本题" ? "" : `${unit.label}：`

    if (keys.some((key) => !optionKeys.includes(key))) {
      issues.push(
        issue("error", "科学性", `${where}答案键 ${keys.join("/")} 不在选项中`, "核对选项 key 与答案 key", {
          code: "answer_not_in_options",
          critical: true,
        })
      )
      critical = true
    }

    const seen = new Set()
    for (const text of texts) {
      if (!text) continue
      if (seen.has(text)) {
        issues.push(
          issue("error", "规范性", `${where}选项内容重复：「${text.slice(0, 20)}」`, "删除或改写重复选项", {
            code: "duplicate_options",
            critical: true,
          })
        )
        critical = true
      }
      seen.add(text)
    }

    for (const text of texts) {
      if (/以上(都|均)|都不对|全都(不对|正确)/.test(text)) {
        issues.push(
          issue("warn", "科学性", `${where}选项「${text}」是“以上都/都不对”型`, "尽量改成具体选项，避免学生靠排除法作答")
        )
      }
    }

    // 正确项明显最长：强化"最长即正确"的应试捷径
    if (keys.length > 0 && texts.length >= 2) {
      const lens = texts.map((text) => text.length)
      const positive = lens.filter((n) => n > 0)
      const max = positive.length > 0 ? Math.max(...positive) : 0
      const min = positive.length > 0 ? Math.min(...positive) : 0
      const keyTexts = asArray(unit.content?.options)
        .filter((option) => keys.includes(option?.key))
        .map((option) => blocksToText(option?.label).trim())
      const keyLongest = keyTexts.length > 0 && keyTexts.every((text) => text.length === max)
      if (min > 0 && max / min >= 2.5 && keyLongest) {
        issues.push(
          issue(
            "warn",
            "区分度",
            `${where}正确项明显长于其他选项（${max} 字 vs ${min} 字）`,
            "压缩正确项或补全干扰项，避免“最长即正确”"
          )
        )
      }
    }

    const stem = blocksToText(unit.content?.stem)
    if (/(不正确|错误|不属于|不是)/.test(stem) && !/(下列|以下)/.test(stem)) {
      issues.push(
        issue("info", "语言", `${where}否定式题干建议加粗/加下划线`, "把“不正确/不属于”等词标出来，减少审题失误")
      )
    }

    if (texts.length > 8) {
      issues.push(issue("info", "规范性", `${where}选项有 ${texts.length} 个`, "确认是否真的需要这么多选项"))
    }
  }

  // ---------- 3) 查重：沿用三档口径 ----------
  const best = asArray(similar).reduce(
    (acc, row) => (Number(row?.similarity) > Number(acc?.similarity ?? 0) ? row : acc),
    null
  )
  if (best) {
    const sim = Number(best.similarity) || 0
    if (sim >= 0.85) {
      issues.push(
        issue("warn", "科学性", `题库里有 1 道高度相似（${Math.round(sim * 100)}%）`, "多半是同一道题换了个写法；对照后决定是否保留", {
          code: "similar_high",
        })
      )
    } else if (sim >= 0.70) {
      issues.push(
        issue("info", "科学性", `题库里有 1 道较相似（${Math.round(sim * 100)}%）`, "同一知识点的辨析题也会落在这一档，不一定是重复", {
          code: "similar_mid",
        })
      )
    } else if (sim >= 0.55) {
      issues.push(
        issue("info", "科学性", `题库里有 1 道相似题（${Math.round(sim * 100)}%）`, "供参考，不一定是重复", {
          code: "similar_low",
        })
      )
    }
  }

  // ---------- 4) 经验正确率（样本 ≥20 才说） ----------
  const attempts = Number(accuracy?.attempts) || 0
  const correct = Number(accuracy?.correct) || 0
  if (attempts >= 20) {
    const p = correct / attempts
    if (p > 0.95) {
      issues.push(issue("info", "难度", `全站作答 ${attempts} 次，正确率 ${Math.round(p * 100)}%，偏易`, "确认是否还值得留在题库"))
    } else if (p < 0.15) {
      issues.push(issue("info", "难度", `全站作答 ${attempts} 次，正确率 ${Math.round(p * 100)}%，偏难`, "核对答案与解析，确认不是题目本身有问题"))
    }
    const authored = Number(difficulty) || 2
    if (authored === 1 && p < 0.5) {
      issues.push(issue("info", "难度", `标为“易”，但实测正确率 ${Math.round(p * 100)}%`, "难度标注与数据不符，建议改为“中/难”"))
    }
    if (authored === 3 && p > 0.7) {
      issues.push(issue("info", "难度", `标为“难”，但实测正确率 ${Math.round(p * 100)}%`, "难度标注与数据不符，建议改为“中/易”"))
    }
  }

  // ---------- 5) 评分与结论 ----------
  issues.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
  const errors = issues.filter((item) => item.severity === "error").length
  const warnings = issues.filter((item) => item.severity === "warn").length
  const infos = issues.filter((item) => item.severity === "info").length
  const score = Math.max(0, Math.min(100, 100 - 12 * errors - 4 * warnings - infos))
  const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D"
  const verdict = critical ? "reject" : errors > 0 || warnings > 0 ? "revise" : "pass"

  return { score, grade, verdict, issues, stats: { errors, warnings, infos } }
}
