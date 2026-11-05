// 把填空题 / 综合题拆成 AI 可逐点判分的 unit specs。
//
// 关键是对齐 paper_items.score_units：教师阅卷台的输入框就是一个 unit，
// AI 的建议也必须一个 unit 一条，否则采纳时分数会错位。
import { blocksToText, countBlanks } from "@/lib/question-model"

function asArray(value) {
  if (Array.isArray(value)) return value
  return value == null || value === "" ? [] : [value]
}

function text(value) {
  return String(value ?? "").trim()
}

function optionTexts(content) {
  return asArray(content?.options).map((option) => ({
    key: text(option?.key),
    text: text(blocksToText(option?.label)),
  }))
}

function keysText(keys) {
  return asArray(keys).map((key) => text(key)).filter(Boolean).join("、")
}

function answerText(type, answer) {
  if (!answer) return ""
  // 客户端把"不会"提交成 {type:"unknown"}（见 Flutter 的 UnknownAnswer）。
  // 这不是空白：学生**主动**标了不会，措辞要区分开，别让模型/教师误以为是漏答。
  if (answer.type === "unknown") return "（学生标记：不会）"
  if (type === "single_choice" || type === "multiple_choice") return keysText(answer.keys)
  if (type === "true_false") return answer.value === true ? "正确" : answer.value === false ? "错误" : ""
  if (type === "fill_blank") return asArray(answer.values).map(text).join(" / ")
  if (type === "short_answer") return text(answer.text ?? asArray(answer.samples).join("\n"))
  return ""
}

function spec({ index, label, kind, mode, max, prompt, reference, alternatives, student }) {
  const value = text(student)
  return {
    index,
    label: label || `第 ${index + 1} 点`,
    kind,
    mode,
    max: Number(max) || 0,
    prompt: text(prompt),
    reference: asArray(reference).map(text).filter(Boolean),
    alternatives: asArray(alternatives).map(text).filter(Boolean),
    student: value,
    blank: value.length === 0,
  }
}

// [student] 默认空串，但**调用方该给就给**：判分点排布对不上时，最不该丢的
// 恰恰是学生的作答 —— 丢了它模型只会说「未作答」，然后给 0 分。
function fallbackSpecs(caps, labels, student = "") {
  return caps.map((max, index) =>
    spec({
      index,
      label: labels[index],
      kind: "unknown",
      mode: "partial",
      max,
      prompt: "",
      reference: [],
      alternatives: [],
      student,
    })
  )
}

function fillSpecs(content, answer, caps, labels) {
  const refs = asArray(content?.answer?.values).map(text)
  const given = asArray(answer?.values).map(text)
  const alternatives = asArray(content?.answer?.alternatives)
  if (caps.length === refs.length && refs.length > 0) {
    return refs.map((reference, index) =>
      spec({
        index,
        label: labels[index],
        kind: "fill_blank",
        mode: "binary",
        max: caps[index],
        prompt: text(blocksToText(content?.stem)),
        reference: [reference],
        alternatives: asArray(alternatives[index]),
        student: given[index],
      })
    )
  }
  // 一个计分点覆盖整题（旧卷/自定义分值）：按整体给部分分
  if (caps.length === 1) {
    return [
      spec({
        index: 0,
        label: labels[0],
        kind: "fill_blank_group",
        mode: "partial",
        max: caps[0],
        prompt: text(blocksToText(content?.stem)),
        reference: refs,
        alternatives: alternatives.flat(),
        student: given.join(" / "),
      }),
    ]
  }
  // 计分点与空数对不上（旧卷/自定义分值）：至少把学生写的每空都带上
  return fallbackSpecs(caps, labels, given.join(" / "))
}

// 综合题的"逐子题"视图：子题原文、参考答案、学生作答。
//
// 子题的答案类型与顶层不同：内容侧是 single_choice / multiple_choice / true_false /
// fill_blank / short_answer（见 answerText 的分支），学生作答侧则是
// choice / tf / blank / text。两边都按**内容侧的类型**分派，字段各取各的。
function compositeRows(content, answer) {
  const subs = asArray(content?.sub)
  const givenSubs = asArray(answer?.subs)
  return subs.map((sub, index) => {
    const given = givenSubs[index] ?? {}
    const isFill = sub?.type === "fill_blank"
    return {
      no: index + 1,
      prompt: text(blocksToText(sub?.stem)),
      reference: isFill
        ? asArray(sub?.answer?.values).map(text).join(" / ")
        : answerText(sub?.type, sub?.answer),
      student: isFill
        ? asArray(given?.values).map(text).join(" / ")
        : answerText(sub?.type, given),
    }
  })
}

// 学生在这道综合题上写了什么（按子题换行）。空白子题不占行 ——
// 全空时必须返回空串，否则 spec.blank 会误判成"答过了"。
function compositeStudentText(content, answer) {
  return compositeRows(content, answer)
    .filter((row) => row.student)
    .map((row) => `（${row.no}）${row.student}`)
    .join("\n")
}

function compositeSpecs(content, answer, caps, labels) {
  const subs = asArray(content?.sub)
  const givenSubs = asArray(answer?.subs)
  const layout = subs.map((sub) =>
    sub?.type === "fill_blank" ? Math.max(countBlanks(blocksToText(sub?.stem)), 1) : 1
  )
  const total = layout.reduce((sum, value) => sum + value, 0)
  const specs = []

  if (caps.length === total && total > 0) {
    let index = 0
    subs.forEach((sub, subIndex) => {
      const given = givenSubs[subIndex] ?? {}
      const stem = text(blocksToText(sub?.stem))
      if (sub?.type === "fill_blank") {
        const refs = asArray(sub?.answer?.values).map(text)
        const values = asArray(given?.values).map(text)
        const alternatives = asArray(sub?.answer?.alternatives)
        for (let blank = 0; blank < layout[subIndex]; blank++) {
          specs.push(
            spec({
              index,
              label: labels[index],
              kind: "fill_blank",
              mode: "binary",
              max: caps[index],
              prompt: stem,
              reference: [refs[blank]],
              alternatives: asArray(alternatives[blank]),
              student: values[blank],
            })
          )
          index += 1
        }
        return
      }
      specs.push(
        spec({
          index,
          label: labels[index],
          kind: sub?.type,
          mode: sub?.type === "short_answer" ? "partial" : "binary",
          max: caps[index],
          prompt: stem,
          reference: answerText(sub?.type, sub?.answer),
          student: answerText(sub?.type, given),
        })
      )
      index += 1
    })
    return specs
  }

  // 旧口径：一个子题一个计分点；填空子题按整体部分分
  if (caps.length === subs.length && subs.length > 0) {
    subs.forEach((sub, subIndex) => {
      const given = givenSubs[subIndex] ?? {}
      specs.push(
        spec({
          index: subIndex,
          label: labels[subIndex],
          kind: sub?.type === "fill_blank" ? "fill_blank_group" : sub?.type,
          mode: sub?.type === "fill_blank" || sub?.type === "short_answer" ? "partial" : "binary",
          max: caps[subIndex],
          prompt: text(blocksToText(sub?.stem)),
          reference:
            sub?.type === "fill_blank"
              ? asArray(sub?.answer?.values).map(text)
              : answerText(sub?.type, sub?.answer),
          alternatives: asArray(sub?.answer?.alternatives).flat(),
          student: answerText(sub?.type, given),
        })
      )
    })
    return specs
  }

  // 整题一个计分点（综合题最常见的一种卷面口径：一道大题 20 分，按整体给分）。
  // 它既对不上"每个子题一个计分点"，也对不上"每个空一个计分点"，
  // 以前直接落到 fallbackSpecs —— 那里 student 是空串，AI 看到的就是"未作答"，
  // 于是整题建议 0 分（2026-11-05 线上踩到：三道综合题全中）。
  if (caps.length === 1) {
    const rows = compositeRows(content, answer)
    const answered = rows.filter((row) => row.student)
    return [
      spec({
        index: 0,
        label: labels[0],
        kind: "composite_group",
        mode: "partial",
        max: caps[0],
        prompt: rows
          .map((row) => (row.prompt ? `（${row.no}）${row.prompt}` : ""))
          .filter(Boolean)
          .join("\n"),
        reference: rows
          .map((row) => (row.reference ? `（${row.no}）${row.reference}` : ""))
          .filter(Boolean),
        alternatives: [],
        student: answered
          .map((row) => `（${row.no}）${row.student}`)
          .join("\n"),
      }),
    ]
  }

  return fallbackSpecs(caps, labels, compositeStudentText(content, answer))
}

function shortSpecs(content, answer, caps, labels) {
  const refs = asArray(content?.answer?.samples).map(text)
  const given = text(answer?.text ?? asArray(answer?.samples).join("\n"))
  if (caps.length === 1) {
    return [
      spec({
        index: 0,
        label: labels[0],
        kind: "short_answer",
        mode: "partial",
        max: caps[0],
        prompt: text(blocksToText(content?.stem)),
        reference: refs,
        student: given,
      }),
    ]
  }
  // 多计分点：同一段作答按评分点给部分分
  return caps.map((max, index) =>
    spec({
      index,
      label: labels[index],
      kind: "short_answer",
      mode: "partial",
      max,
      prompt: text(blocksToText(content?.stem)),
      reference: refs,
      student: given,
    })
  )
}

export function buildUnitSpecs(item, record, labels = []) {
  const caps = (item?.score_units ?? [item?.score ?? 0]).map((value) => Number(value) || 0)
  const content = item?.content ?? {}
  const answer = record?.answer ?? {}
  if (item?.qtype === "fill_blank") return fillSpecs(content, answer, caps, labels)
  if (item?.qtype === "composite") return compositeSpecs(content, answer, caps, labels)
  if (item?.qtype === "short_answer") return shortSpecs(content, answer, caps, labels)
  // 认不出的题型也别把学生写的丢掉（宁可让模型看到原文，也不要它说"未作答"）
  return fallbackSpecs(caps, labels, answerText(item?.qtype, answer))
}
