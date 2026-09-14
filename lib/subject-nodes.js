// 科目树纯工具（Server/Client 共用）：树结构矩阵与数据库触发器一致；
// 另含节点查询列清单与路径合成——所有页面/工作台共用一套口径，避免各处重复实现。

export const SCOPE_LABELS = {
  common: "公共科目",
  vocational: "专业目录",
}

export const KIND_LABELS = {
  discipline: "公共学科",
  category: "专业大类",
  major: "专业",
  course: "课程",
}

export function scopeLabel(scope) {
  return SCOPE_LABELS[scope] ?? scope
}

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? kind
}

// 可挂题目节点：公共学科（单层）或课程（两层/三层结构的末端）
export function isAttachable(kind) {
  return kind === "discipline" || kind === "course"
}

// 允许的子节点类型（kind === null 表示建根节点）
export function childKinds(scope, kind) {
  if (kind === null) return scope === "common" ? ["discipline"] : ["category"]
  if (scope === "common" && kind === "discipline") return ["course"]
  if (scope === "vocational" && kind === "category") return ["major"]
  if (scope === "vocational" && kind === "major") return ["course"]
  return []
}

const ROOT_KEY = "root" // 根节点（parent_id 为 null）在归组表中的键

// 按父节点归组
function groupByParent(nodes) {
  const byParent = new Map()
  for (const n of nodes) {
    const key = n.parent_id ?? ROOT_KEY
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(n)
  }
  return byParent
}

// 全量节点 → {common: [{node, children}…], vocational: […]}
export function buildTrees(nodes) {
  const byParent = groupByParent(nodes)
  const childrenOf = (id) =>
    (byParent.get(id) ?? []).sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh-Hans-CN")
    )
  const build = (scope) => {
    const walk = (parentId) =>
      childrenOf(parentId)
        .filter((n) => n.scope === scope)
        .map((n) => ({ node: n, children: walk(n.id) }))
    return walk(ROOT_KEY)
  }
  return { common: build("common"), vocational: build("vocational") }
}

// 节点及其全部后代 id（"按科目筛选"的口径：选父节点即含其下所有课程）
export function subtreeIdsOf(nodes, rootId) {
  const byParent = groupByParent(nodes)
  const ids = []
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()
    ids.push(id)
    for (const child of byParent.get(id) ?? []) stack.push(child.id)
  }
  return ids
}

// ---------- 查询 ----------
// 科目节点的展示列（全库统一；新增列只需改这里）
export const SUBJECT_NODE_COLUMNS = "id, parent_id, scope, kind, name, sort_order, is_frozen"

// 返回查询构造器（未 await），便于与其它查询一起进 Promise.all
export function subjectNodesQuery(supabase, { sorted = false } = {}) {
  let q = supabase.from("subject_nodes").select(SUBJECT_NODE_COLUMNS)
  if (sorted) q = q.order("sort_order").order("name")
  return q
}

// ---------- 索引与路径 ----------
// 防御脏数据成环；正常科目树深度远小于此
const MAX_DEPTH = 10

// 节点列表 → { byId, pathOf }：byId 供按 id 取节点，pathOf 合成"根 / … / 自身"名称链
// （pathOf 带 memo，行数据装配时逐行调用也不重复回溯）
export function indexNodes(nodes) {
  const byId = new Map((nodes ?? []).map((n) => [n.id, n]))
  const cache = new Map()
  const pathOf = (id) => {
    if (!id) return ""
    if (cache.has(id)) return cache.get(id)
    const parts = []
    let cur = byId.get(id)
    let depth = 0
    while (cur && depth++ < MAX_DEPTH) {
      parts.unshift(cur.name)
      cur = cur.parent_id ? byId.get(cur.parent_id) : null
    }
    const path = parts.join(" / ")
    cache.set(id, path)
    return path
  }
  return { byId, pathOf }
}

// 一次性取路径（选择器/详情页等单点场景）
export function nodePathOf(nodes, id) {
  return indexNodes(nodes).pathOf(id)
}
