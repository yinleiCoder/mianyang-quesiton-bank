// AI 逐题错因诊断的提示词与返回校验。
//
// 数据来源（两个现成 RPC 按 seq 合并）：
//   · class_ai_payload：题干、难度、知识点、填空高频错答、样本；
//   · paper_question_stats：选项 key/文本/计数（班级范围）。
// 硬边界：
//   · 只给教学建议，不改成绩、不写库；
//   · 错因 code 用固定分类；evidence 必须是输入原文的子串（程序校验）；
//   · 样本 <5 不做强结论；不发送学生姓名。
const ERROR_CODES = [
  { value: "concept_confusion", label: "概念混淆" },
  { value: "misreading", label: "审题偏差" },
  { value: "calculation", label: "计算错误" },
  { value: "unit", label: "单位或格式" },
  { value: "knowledge_gap", label: "知识缺口" },
  { value: "guessing", label: "猜测" },
  { value: "time_pressure", label: "时间压力" },
  { value: "other", label: "其他" },
]

export const ERROR_CODE_LABELS = Object.fromEntries(
  ERROR_CODES.map((item) => [item.value, item.label])
)

const MIN_SAMPLE = 5
const MAX_QUESTIONS = 5
const MAX_CAUSES = 4

export const SYSTEM_PROMPT = `你是中职教研员。根据每道题的选项分布、填空高频错答与样本，判断学生的主要错因，并给出下节课可执行的教学动作。

只输出一个 json 对象，不要任何解释文字、不要 Markdown 代码块。对象结构：
{
  "questions": [
    {
      "seq": 12,
      "sample": 35,
      "causes": [
        {
          "code": "concept_confusion",
          "share": 0.4,
          "evidence": "引用选项文本/填空文本/样本里的原文",
          "remedy": "一句话教学动作"
        }
      ],
      "teaching_move": "这道题在课堂上怎么讲",
      "caveats": "样本或数据不足的说明"
    }
  ],
  "summary": "本卷主要失分集中在……",
  "caveats": "整体不确定性说明"
}

规则：
- code 只能是：concept_confusion / misreading / calculation / unit / knowledge_gap / guessing / time_pressure / other；
- share 是 0–1 的小数，同一题各错因合计约等于 1；每题最多 4 个错因；
- evidence 必须引用 user 数据里的原文（选项文本、填空文本、题干或样本），不超过 40 字，不要转述；
- 只用 user 给的数据，不要编造学生、选项或分数；
- 样本少于 5 的题不要下强结论，caveats 里写清；
- 不出现学生姓名，用“选 B 的学生”“部分学生”；
- teaching_move 要具体到课堂动作，不要写“加强练习”这种空话。`

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function textOf(value) {
  return String(value ?? "").trim()
}

/** 题目的可引用原文（evidence 子串校验用）。 */
export function evidenceHaystack(question) {
  return [
    question?.stem,
    ...asArray(question?.options).map((option) => option?.text),
    ...asArray(question?.fill_texts).map((item) => item?.text),
    ...asArray(question?.samples).map((item) => (typeof item === "string" ? item : item?.text)),
  ]
    .filter(Boolean)
    .join("\n")
}

// 证据校验：模型常把原文包成「选项“-1”，20 人」「题干“判别式的值为（ ）”」。
// 严格 includes 会把这些真实引用全丢掉（2026-11-03 真实联调踩到），所以：
//   1) 原文直接命中 → 通过；
//   2) 引号里的那段是原文子串 → 通过；
//   3) 去掉标点/空白/引号后再比 → 通过（容忍全角/半角括号）。
// 仍然挡得住“编造的证据”：引号里和去标点后都不在原文里。
function normalizeEvidence(value) {
  return String(value ?? "").replace(/[“”"'「」『』（）()，,。.、；;：:\s]/g, "")
}

export function evidenceMatches(evidence, haystack) {
  const text = textOf(evidence)
  const source = String(haystack ?? "")
  if (!text || !source) return false
  if (source.includes(text)) return true

  const quoted = [...text.matchAll(/[“"「『']([^”"」』']+)[”"」』']/g)]
    .map((match) => textOf(match[1]))
    .filter(Boolean)
  if (quoted.some((piece) => source.includes(piece))) return true

  const normalizedSource = normalizeEvidence(source)
  if (normalizedSource.includes(normalizeEvidence(text))) return true
  if (quoted.some((piece) => normalizedSource.includes(normalizeEvidence(piece)))) return true

  const core = text
    .replace(/^(选项|题干|填空|样本)\s*[“"「『]?/, "")
    .replace(/[”"」』]?\s*[，,]?\s*\d+\s*人\s*$/, "")
    .trim()
  return Boolean(core) && source.includes(core)
}

/** 组 messages：questions 是已合并、已去姓名的紧凑题目。 */
export function buildErrorDiagnosisMessages({ paper = null, classInfo = null, questions = [] } = {}) {
  const payload = {
    paper: paper
      ? {
          title: paper.title ?? "",
          exam_name: paper.exam_name ?? "",
          subject_label: paper.subject_label ?? "",
          full_score: paper.full_score ?? null,
        }
      : null,
    class: classInfo
      ? { name: classInfo.name ?? "", student_count: classInfo.student_count ?? null }
      : null,
    questions: asArray(questions).slice(0, MAX_QUESTIONS).map((question) => ({
      seq: question.seq,
      qtype: question.qtype,
      difficulty: question.difficulty ?? null,
      node: question.node ?? "",
      stem: question.stem ?? "",
      sample: question.sample ?? 0,
      correct_rate: question.correct_rate ?? null,
      options: asArray(question.options).map((option) => ({
        key: option.key,
        text: option.text,
        is_answer: Boolean(option.is_answer),
        count: option.count ?? 0,
      })),
      fill_texts: asArray(question.fill_texts)
        .slice(0, 8)
        .map((item) => ({ text: item.text, count: item.count ?? 0 })),
      samples: asArray(question.samples).slice(0, 3),
    })),
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请逐题诊断错因，只输出 json 对象：\n${JSON.stringify(payload, null, 2)}`,
    },
  ]
}

/**
 * 校验模型返回。questions 是输入题（含 seq/sample/haystack），用于题号、样本与证据核对。
 * 返回 {ok:true,diagnosis,warnings} 或 {ok:false,reason}。
 */
export function validateErrorDiagnosis(value, { questions = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "返回的不是对象" }
  }
  if (!Array.isArray(value.questions)) {
    return { ok: false, reason: "questions 不是数组" }
  }

  const bySeq = new Map(
    asArray(questions).map((question) => [Number(question.seq), question])
  )
  const warnings = []
  const out = []

  for (const raw of value.questions) {
    const seq = Number(raw?.seq)
    const source = bySeq.get(seq)
    if (!source) {
      warnings.push(`忽略了不存在的题号 ${raw?.seq ?? "?"}`)
      continue
    }
    const haystack = evidenceHaystack(source)
    const causes = []
    for (const cause of asArray(raw?.causes)) {
      const code = textOf(cause?.code)
      if (!ERROR_CODE_LABELS[code]) {
        warnings.push(`第 ${seq} 题有未知错因分类，已忽略`)
        continue
      }
      const evidence = textOf(cause?.evidence)
      if (!evidence || !evidenceMatches(evidence, haystack)) {
        warnings.push(`第 ${seq} 题有证据无法在原文中核对，已忽略`)
        continue
      }
      let share = Number(cause?.share)
      if (!Number.isFinite(share)) share = 0
      share = Math.max(0, Math.min(1, share))
      causes.push({
        code,
        share,
        evidence,
        remedy: textOf(cause?.remedy),
      })
      if (causes.length >= MAX_CAUSES) break
    }
    if (causes.length === 0) {
      warnings.push(`第 ${seq} 题没有可用的错因，已跳过`)
      continue
    }
    causes.sort((a, b) => b.share - a.share)
    const shareTotal = causes.reduce((sum, cause) => sum + cause.share, 0)
    if (shareTotal < 0.8 || shareTotal > 1.2) {
      warnings.push(`第 ${seq} 题的错因占比合计不在 0.8–1.2，请自行核对`)
    }
    if (Number(source.sample) < MIN_SAMPLE) {
      warnings.push(`第 ${seq} 题样本不足 ${MIN_SAMPLE}，结论仅供参考`)
    }
    out.push({
      seq,
      sample: Number(source.sample) || 0,
      causes,
      teaching_move: textOf(raw?.teaching_move),
      caveats: textOf(raw?.caveats),
    })
  }

  if (out.length === 0) {
    return { ok: false, reason: "没有可用的错因诊断" }
  }
  out.sort((a, b) => a.seq - b.seq)
  return {
    ok: true,
    diagnosis: {
      questions: out,
      summary: textOf(value.summary),
      caveats: textOf(value.caveats),
    },
    warnings: [...new Set(warnings)],
  }
}

function sampleText(item) {
  if (typeof item === "string") return item
  return textOf(item?.text ?? item?.answer ?? "")
}

/**
 * 合并两份数据，挑出“可诊断”的题：
 *   classPayload = class_ai_payload 的 payload（题干/难度/知识点/样本）；
 *   paperStats   = paper_question_stats 的返回（选项文本/计数、填空频次）。
 * 只保留已判分 ≥ minSample、有正确率、且有选项文本或填空文本的题，按正确率升序取前 max 道。
 * 姓名一律不进入返回值。
 */
export function pickDiagnosableQuestions(
  classPayload,
  paperStats,
  { max = MAX_QUESTIONS, minSample = MIN_SAMPLE } = {}
) {
  const payloadQuestions = asArray(classPayload?.questions)
  const statsBySeq = new Map(
    asArray(paperStats?.items).map((item) => [Number(item?.seq), item])
  )
  const picked = []

  for (const question of payloadQuestions) {
    const seq = Number(question?.seq)
    const stats = statsBySeq.get(seq)
    const sample = Number(question?.graded ?? stats?.graded) || 0
    if (sample < minSample) continue
    const correctRate = Number(question?.correct_rate ?? stats?.correct_rate)
    if (!Number.isFinite(correctRate)) continue

    const options = asArray(stats?.options ?? question?.options)
      .map((option) => ({
        key: textOf(option?.key),
        text: textOf(option?.text),
        is_answer: Boolean(option?.is_answer),
        count: Number(option?.count) || 0,
      }))
      .filter((option) => option.key && option.text)
    const fillTexts = asArray(stats?.text_counts ?? question?.fill_texts)
      .map((item) => ({ text: textOf(item?.text), count: Number(item?.count) || 0 }))
      .filter((item) => item.text)
      .slice(0, 8)
    if (options.length === 0 && fillTexts.length === 0) continue

    picked.push({
      seq,
      qtype: question?.qtype ?? "",
      difficulty: question?.difficulty ?? null,
      node: question?.node ?? "",
      stem: textOf(question?.stem),
      sample,
      correct_rate: correctRate,
      options,
      fill_texts: fillTexts,
      samples: asArray(question?.samples).map(sampleText).filter(Boolean).slice(0, 3),
    })
  }

  picked.sort(
    (a, b) => a.correct_rate - b.correct_rate || a.seq - b.seq
  )
  return picked.slice(0, max)
}

export { ERROR_CODES, MAX_QUESTIONS, MIN_SAMPLE }
