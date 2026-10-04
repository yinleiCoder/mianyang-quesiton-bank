// 协同组卷（0085）的取数与文案。
//
// 与 lib/paper-workbench.js 的分工：那边是"卷子"的装载，这边只服务子卷任务
// （分派清单、题项归属、我的任务）。**不 import next/cache 系** —— 客户端组件也要用。
//
// 三个 RPC 的分工：
//   · paper_assignments_json(version)  一版卷子的分派清单（含指派人姓名、段内已有几题）
//   · paper_item_ownership(version)    题项 → 大题序号 / 段内题号 / 归属哪段
//   · list_my_paper_assignments()      跨卷子的"我的任务"
//
// 「段内题号」是这一层的核心概念：assignment 记的是 (大题序号, 第 X~Y 题)，
// 这里的 X/Y **按大题内部数**（不是全卷题号）。全卷题号在 paper_items.seq 上，
// 卷面渲染用它；被指派人只关心自己那段，所以两者都要能看到（见 buildSegmentView）。

/** 分段状态：给界面用的一处文案（服务端是 open/claimed/submitted/locked）。 */
export const ASSIGNMENT_STATES = {
  open: { text: "待认领", cls: "bg-muted text-muted-foreground" },
  claimed: { text: "编辑中", cls: "bg-amber-100 text-amber-700" },
  submitted: { text: "已交（锁）", cls: "bg-emerald-100 text-emerald-700" },
  locked: { text: "创始人已确认", cls: "bg-emerald-100 text-emerald-700" },
}
export const assignmentStateChip = (s) =>
  ASSIGNMENT_STATES[s] ?? { text: s, cls: "bg-muted text-muted-foreground" }

/** 段的题号文案：「大题三 第 3~7 题」 */
export function spanLabel(a) {
  const title = a.section_title?.trim() || `第 ${a.section_ord} 大题`
  return `${title} · 第 ${a.from_qno}~${a.to_qno} 题`
}

/** 一版卷子的分派清单。读不到（无权/出错）返回 []，由调用方决定怎么提示。 */
export async function loadPaperAssignments(supabase, versionId) {
  const { data, error } = await supabase.rpc("paper_assignments_json", {
    p_version_id: versionId,
  })
  if (error) return { assignments: [], error }
  return { assignments: data ?? [], error: null }
}

/** 题项归属：item_id → { section_ord, pos, assignment_id }。段编辑器靠它摆位。 */
export async function loadItemOwnership(supabase, versionId) {
  const { data, error } = await supabase.rpc("paper_item_ownership", {
    p_version_id: versionId,
  })
  if (error) return { ownership: new Map(), error }
  return {
    ownership: new Map((data ?? []).map((r) => [r.item_id, r])),
    error: null,
  }
}

/** 我参与的组卷（跨卷子）。 */
export async function loadMyAssignments(supabase, { limit = 50, offset = 0 } = {}) {
  const { data, error } = await supabase.rpc("list_my_paper_assignments", {
    p_limit: limit,
    p_offset: offset,
  })
  if (error) throw error
  const rows = data ?? []
  return { rows, total: rows.length ? Number(rows[0].total_count) : 0 }
}

/**
 * 把「一版卷面 + 我的那一段」折成段编辑器要的样子。
 *
 * 为什么要这一层：卷面快照里只有"这个大题有哪些题"，而段编辑器要的是
 * **带空位的槽位表** —— 我那段是第 3~7 题，那么第 3~7 个槽位是我的（有题就填、
 * 没题就是空槽），其余槽位显示别人的题（只读）。这样题号才是**绝对**的：
 * 直接渲染"我的题"会让第 3~7 题显示成第 1~5 题（这是设计时记下的坑）。
 *
 * @param section   快照里的某个大题（items 已按 seq 排好）
 * @param ownership item_id → 归属（loadItemOwnership 的产物）
 * @param assignment 我的那一段
 */
export function buildSegmentView(section, ownership, assignment) {
  const mine = []
  const others = new Map() // pos → item（别人占的槽位 / 创始人的题）
  for (const item of section.items ?? []) {
    const own = ownership.get(item.id)
    const pos = own?.pos ?? item.pos ?? 0
    if (own?.assignment_id === assignment.id) mine.push({ ...item, pos })
    else others.set(pos, item)
  }
  mine.sort((a, b) => a.pos - b.pos)

  // 我的槽位：从 from_qno 起一共 (to_qno-from_qno+1) 个；第 i 个槽位要么是我挑的第 i 题，要么空着
  const slots = []
  for (let i = 0; i < assignment.to_qno - assignment.from_qno + 1; i += 1) {
    const pos = assignment.from_qno + i
    slots.push({ pos, item: mine[i] ?? null })
  }

  // 这一段在整道大题里的位置：前面有几道（创始人或别人的），用于显示"我在第几题"
  const before = [...others.keys()].filter((p) => p < assignment.from_qno).length

  return { slots, mine, others, before, cap: slots.length }
}

/** 段的进度文案：已挑几题 / 区间几题 + 目标分。 */
export function segmentProgress(assignment) {
  const cap = assignment.to_qno - assignment.from_qno + 1
  const picked = Number(assignment.item_count ?? 0)
  return `${picked}/${cap} 题 · 目标 ${Number(assignment.score ?? 0)} 分`
}
