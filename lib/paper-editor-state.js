// 组卷编辑器的状态机（纯函数，可单测）。
//
// 设计取舍：**派生量一律不进 state**。每题的分值明细、大题小计、全卷合计、卷内连续题号，
// 全部在 selector 里按当前口径现算。理由：教师改一次「本大题每题 2 分」，
// 若把结果物化进 state 就要遍历改 32 条记录，且很容易漏改其中一条，
// 于是屏幕上出现"标题写 3 分、某一题还是 2 分"这种对不上的状态。
//
// state 的形状刻意与 save_paper_draft 的入参形状对齐，保存时几乎是直接搬运。

import { expandUnits, sumUnits, round2, sectionScore, paperTotal, paperItemCount } from "@/lib/paper-model"
import { contentSummary } from "@/lib/question-model"

let __key = 0
const genKey = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `k_${Date.now()}_${++__key}`

export function emptySection(patch = {}) {
  return {
    key: genKey(),
    title: "",
    instruction: "",
    score_mode: "per_item",
    score_each: 2,
    items: [],
    ...patch,
  }
}

// 把服务端返回的整卷快照装进编辑器状态
export function fromSnapshot(snap) {
  const sections = (snap.sections ?? []).map((s) =>
    emptySection({
      title: s.title,
      instruction: s.instruction ?? "",
      score_mode: s.score_mode,
      score_each: Number(s.score_each),
      items: (s.items ?? []).map(toEditorItem),
    })
  )
  return {
    versionId: snap.version_id,
    paperId: snap.paper_id,
    status: snap.status,
    courseNodeId: snap.course_node_id,
    updatedUs: snap.updated_us,
    meta: {
      title: snap.title ?? "",
      exam_name: snap.exam_name ?? "",
      subject_label: snap.subject_label ?? "",
      duration_minutes: snap.duration_minutes ?? 90,
      target_score: snap.target_score ?? null,
      header: snap.header ?? {},
      instructions: snap.instructions ?? [],
    },
    // 全新的卷还没有大题，这里直接播种一个。
    // **不要**改用 useEffect 去补：React StrictMode 下开发环境会把 effect 跑两遍，
    // 结果是新建的试卷带着两个一模一样的大题出来（真踩过）。
    // 初始 state 是纯函数算出来的，跑几次都只有一个。
    sections: sections.length > 0 ? sections : [emptySection({ title: "单项选择题", score_mode: "per_item", score_each: 3 })],
    dirty: false,
  }
}

// 题库条目 / 快照题项 → 编辑器题项。
// custom_units 初值为 null = "跟随大题口径"；教师一旦单独改过就固定成显式明细。
function toEditorItem(src, { custom = null } = {}) {
  return {
    key: genKey(),
    question_id: src.question_id,
    question_version_id: src.question_version_id,
    qtype: src.qtype,
    difficulty: src.difficulty ?? 2,
    summary: src.summary ?? "",
    content: src.content ?? null,
    available: src.available ?? true,
    stale: src.stale ?? false,
    origin: src.origin ?? "bank",
    note: src.note ?? "",
    custom_units: custom,
  }
}

export function itemFromBank(row) {
  return toEditorItem({
    question_id: row.question_id,
    // 题库选择器那一行的 id **就是** question_versions.id（它查的是版本表）。
    // 这里必须显式映射：漏掉的话送出去的是一个空版本指针，
    // 服务端只会回一句"第 N 题引用的题库版本不存在"，看不出是前端没给。
    question_version_id: row.question_version_id ?? row.version_id ?? row.id,
    qtype: row.qtype,
    difficulty: row.difficulty,
    // 题库行只有 content，没有现成的摘要字段，从题干现算
    summary: row.summary ?? contentSummary(row.content),
    content: row.content,
    available: true,
    stale: false,
    origin: row.origin ?? "bank",
  })
}

export function paperEditorReducer(state, action) {
  switch (action.type) {
    case "load":
      return fromSnapshot(action.snapshot)

    case "meta":
      return { ...state, meta: { ...state.meta, ...action.patch }, dirty: true }

    case "sectionAdd":
      return { ...state, sections: [...state.sections, emptySection(action.patch)], dirty: true }

    case "sectionUpdate": {
      const sections = state.sections.map((s, i) =>
        i === action.index ? { ...s, ...action.patch } : s
      )
      return { ...state, sections, dirty: true }
    }

    case "sectionRemove": {
      const sections = state.sections.filter((_, i) => i !== action.index)
      return { ...state, sections, dirty: true }
    }

    case "sectionMove": {
      const sections = [...state.sections]
      const [it] = sections.splice(action.from, 1)
      if (!it) return state
      sections.splice(action.to, 0, it)
      return { ...state, sections, dirty: true }
    }

    // 从题库拖入。同一份卷不能用两道相同的题（DB 有唯一约束），这里先拦一次并给出可读原因。
    case "itemsAdd": {
      const incoming = action.items ?? []
      const exists = new Set(state.sections.flatMap((s) => s.items.map((i) => i.question_id)))
      const dup = incoming.filter((i) => exists.has(i.question_id))
      if (dup.length > 0) {
        return { ...state, lastError: `卷内已有这 ${dup.length} 道题，不能重复加入` }
      }
      const sections = state.sections.map((s, i) => {
        if (i !== action.index) return s
        const items = [...s.items]
        items.splice(action.at ?? items.length, 0, ...incoming)
        return { ...s, items }
      })
      return { ...state, sections, dirty: true, lastError: null }
    }

    case "itemRemove": {
      const sections = state.sections.map((s, i) =>
        i === action.sectionIndex
          ? { ...s, items: s.items.filter((_, j) => j !== action.itemIndex) }
          : s
      )
      return { ...state, sections, dirty: true }
    }

    case "itemMove": {
      const sections = state.sections.map((s) => ({ ...s, items: [...s.items] }))
      const from = sections[action.fromSection]
      const to = sections[action.toSection]
      if (!from || !to) return state
      const [moved] = from.items.splice(action.fromIndex, 1)
      if (!moved) return state
      to.items.splice(action.toIndex, 0, moved)
      return { ...state, sections, dirty: true }
    }

    case "itemUnits":
    case "itemNote": {
      const sections = state.sections.map((s, i) => {
        if (i !== action.sectionIndex) return s
        return {
          ...s,
          items: s.items.map((it, j) => {
            if (j !== action.itemIndex) return it
            return action.type === "itemUnits"
              ? { ...it, custom_units: action.units }
              : { ...it, note: action.note }
          }),
        }
      })
      return { ...state, sections, dirty: true }
    }

    // 「跟随大题口径」：把这一题的定制清掉
    case "itemResetUnits": {
      const sections = state.sections.map((s, i) =>
        i === action.sectionIndex
          ? { ...s, items: s.items.map((it, j) => (j === action.itemIndex ? { ...it, custom_units: null } : it)) }
          : s
      )
      return { ...state, sections, dirty: true }
    }

    case "saved":
      return { ...state, dirty: false, updatedUs: action.updatedUs, status: action.status ?? state.status }

    case "error":
      return { ...state, lastError: action.message }

    case "clearError":
      return { ...state, lastError: null }

    default:
      return state
  }
}

// ---------------- selectors ----------------

export function itemUnits(section, item) {
  return expandUnits({
    mode: section.score_mode,
    qtype: item.qtype,
    content: item.content,
    scoreEach: section.score_each,
    custom: item.custom_units,
  })
}

export function itemScore(section, item) {
  return round2(sumUnits(itemUnits(section, item)))
}

// 渲染用视图模型：把派生量算好一次性交给组件，组件不再自己算分。
// 卷内题号跨大题连续累加（真题的编号就是 1..N 一路排下来的）。
export function buildView(state) {
  let seq = 0
  const sections = state.sections.map((s, si) => {
    const items = s.items.map((it) => {
      seq += 1
      return { ...it, seq, score: itemScore(s, it), units: itemUnits(s, it) }
    })
    const withScore = { ...s, index: si, items }
    return { ...withScore, itemCount: items.length, score: sectionScore(withScore) }
  })
  return {
    meta: state.meta,
    sections,
    itemCount: paperItemCount(sections),
    total: paperTotal(sections),
    target: state.meta.target_score == null ? null : Number(state.meta.target_score),
    diffToTarget:
      state.meta.target_score == null ? null : round2(paperTotal(sections) - Number(state.meta.target_score)),
  }
}

// 提交给 save_paper_draft 的载荷。只带指针与覆盖项——题目内容由服务端按版本取，
// 客户端传内容等于给了伪造的机会。
export function toSavePayload(state) {
  return {
    meta: {
      title: state.meta.title,
      exam_name: state.meta.exam_name,
      subject_label: state.meta.subject_label,
      duration_minutes: state.meta.duration_minutes,
      // 显式传 null 表示"清空目标分"：服务端用 `p_meta ? 'target_score'` 区分
      // "没传这个字段" 与 "传了 null"，所以这里必须保留键
      target_score: state.meta.target_score,
      header: state.meta.header,
      instructions: state.meta.instructions,
    },
    sections: state.sections.map((s) => ({
      title: s.title,
      instruction: s.instruction,
      score_mode: s.score_mode,
      score_each: s.score_each,
      items: s.items.map((it) => ({
        question_id: it.question_id,
        question_version_id: it.question_version_id,
        custom_units: it.custom_units,
        origin: it.origin,
        note: it.note || null,
      })),
    })),
  }
}
