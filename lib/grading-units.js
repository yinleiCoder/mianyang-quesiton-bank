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

function fallbackSpecs(caps, labels) {
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
      student: "",
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
  return fallbackSpecs(caps, labels)
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

  return fallbackSpecs(caps, labels)
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
  return fallbackSpecs(caps, labels)
}
