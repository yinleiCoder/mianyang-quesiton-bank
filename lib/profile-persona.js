// 学习画像的 persona/summary 纯函数（Web 与 Flutter 各一份镜像）。
//
// 输入是 0128 student_learning_profile 的返回：{ student, window_days, axes, caveats }。
// 这里**不调用大模型**：标签是规则表命中的，理由必须带实际数值；成长语气，禁止
// “学困/差生/没天赋”等词；不推断人格/心理特征。
//
// Flutter 镜像：mianyang_quiz/lib/utils/profile_persona.dart，改一处必须改另一处。

export const PERSONAS = {
  steady: "稳健型",
  sprinter: "冲刺型",
  explorer: "探索型",
  diligent: "勤奋型",
  balanced: "均衡型",
  growing: "成长型",
  newcomer: "新同学",
}

const MIN_SUFFICIENT = 5
const ORDER = ["mastery", "accuracy", "effort", "growth", "breadth", "stability"]

function scoreOf(axes, key) {
  const axis = (axes ?? []).find((item) => item.key === key)
  if (!axis || axis.score == null || !Number.isFinite(Number(axis.score))) return null
  return Number(axis.score)
}

function labelOf(axes, key) {
  return (axes ?? []).find((item) => item.key === key)?.label ?? key
}

function fmt(value) {
  return Math.round(Number(value) || 0)
}

function sufficientAxes(axes) {
  return (axes ?? []).filter(
    (axis) => axis?.sufficient !== false && axis?.score != null && Number.isFinite(Number(axis.score))
  )
}

/** 规则表按顺序命中，第一条为准。 */
export function buildPersona(axes) {
  const list = sufficientAxes(axes)
  if (list.length < MIN_SUFFICIENT) {
    return {
      key: "newcomer",
      label: PERSONAS.newcomer,
      reason: `还差 ${MIN_SUFFICIENT - list.length} 个维度有数据；再练几题就能生成画像`,
    }
  }

  const mastery = scoreOf(axes, "mastery")
  const accuracy = scoreOf(axes, "accuracy")
  const effort = scoreOf(axes, "effort")
  const growth = scoreOf(axes, "growth")
  const breadth = scoreOf(axes, "breadth")
  const stability = scoreOf(axes, "stability")
  const scores = list.map((axis) => Number(axis.score))
  const spread = Math.max(...scores) - Math.min(...scores)
  const atLeast = (value, line) => value != null && value >= line
  const below = (value, line) => value != null && value < line

  if (atLeast(mastery, 75) && atLeast(accuracy, 75) && atLeast(stability, 70)) {
    return {
      key: "steady",
      label: PERSONAS.steady,
      reason: `掌握力 ${fmt(mastery)}、准确率 ${fmt(accuracy)}、稳定性 ${fmt(stability)} 均在 70 以上`,
    }
  }
  if (atLeast(growth, 60) && atLeast(effort, 70)) {
    return {
      key: "sprinter",
      label: PERSONAS.sprinter,
      reason: `进步力 ${fmt(growth)}、勤奋度 ${fmt(effort)}，近期上升明显`,
    }
  }
  if (atLeast(breadth, 70) && below(accuracy, 70)) {
    return {
      key: "explorer",
      label: PERSONAS.explorer,
      reason: `知识面 ${fmt(breadth)} 很宽，准确率 ${fmt(accuracy)} 还有提升空间`,
    }
  }
  if (atLeast(effort, 75) && below(accuracy, 65)) {
    return {
      key: "diligent",
      label: PERSONAS.diligent,
      reason: `勤奋度 ${fmt(effort)} 很高，准确率 ${fmt(accuracy)} 暂时偏低`,
    }
  }
  if (spread <= 15) {
    return {
      key: "balanced",
      label: PERSONAS.balanced,
      reason: `六轴最高与最低只差 ${fmt(spread)}，发展比较均衡`,
    }
  }
  return {
    key: "growing",
    label: PERSONAS.growing,
    reason: "六轴已有数据，仍在形成稳定形状",
  }
}

/** 一句总结：强项 + 最该补的一项；不贴能力标签。 */
export function buildSummary(axes, persona = buildPersona(axes)) {
  const list = sufficientAxes(axes)
  if (list.length === 0) return "再练几题，就能生成你的学习画像。"
  const sorted = [...list].sort((a, b) => Number(b.score) - Number(a.score))
  const top = sorted[0]
  const bottom = sorted[sorted.length - 1]
  const topText = `${top.label} ${fmt(top.score)}`
  if (top.key === bottom.key) {
    return `目前${topText}；下一步保持练习节奏，再看看其他维度。`
  }
  const bottomText = `${bottom.label} ${fmt(bottom.score)}`
  const advice =
    bottom.key === "effort"
      ? "下一步先把练习频率提上来"
      : bottom.key === "accuracy"
        ? "下一步优先补准确率，做完先核对再提交"
        : bottom.key === "breadth"
          ? "下一步可以多换几个知识点练"
          : bottom.key === "stability"
            ? "下一步把每天的练习量稳住"
            : bottom.key === "growth"
              ? "下一步用近两周的正确率对比找回升点"
              : `下一步优先补${bottom.label}`
  return `你的强项是${topText}；${bottomText} 是最该补的。${advice}。${persona.reason}。`
}

/** RPC 返回 → 完整画像（加 persona/summary，不改原始字段）。 */
export function composeProfile(raw) {
  if (!raw || typeof raw !== "object") return raw
  const persona = buildPersona(raw.axes)
  return { ...raw, persona, summary: buildSummary(raw.axes, persona) }
}

export { ORDER, MIN_SUFFICIENT }
