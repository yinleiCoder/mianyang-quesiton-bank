// 知识点标签（tags）的展示口径：层级路径、范围过滤、查询列。
//
// 与 lib/subject-nodes.js 是**姊妹模块**，两处刻意长得像：
// 科目树（subject_nodes）与知识点树（tags，0096 起 parent_id 自引用）都是"任意深度的树"，
// 路径合成、防环、范围过滤这些事只该有一套写法。
//
// 但两张表**不合并**：科目树是题库的组织骨架（题挂在它上面），
// 知识点是给题打的标签（version_tags）。一个题属于一个科目，可以有很多知识点。

import { subtreeIdsOf } from "@/lib/subject-nodes"

// 展示列（全库统一；新增列只需改这里）。排序与科目节点同义：先 sort_order 再名字。
export const TAG_FULL_COLUMNS = "id, name, parent_id, subject_node_id, sort_order"

// 防御脏数据成环；正常知识点树深度远小于此
const MAX_DEPTH = 10

/**
 * 标签列表 → { byId, pathOf, ancestorPathOf }。
 *
 * pathOf("根 / … / 自身") 用于"这个名字在这棵树里的什么位置"；
 * ancestorPathOf 只给祖先那段（不含自己），下拉里自己已经写在左边了。
 * 两者都从同一份链推导，别在调用方拿字符串长度去截——名字里带 " / " 就会截错。
 */
export function tagIndex(tags) {
  const byId = new Map((tags ?? []).map((t) => [t.id, t]))
  const cache = new Map()
  const chainOf = (id) => {
    if (!id) return []
    if (cache.has(id)) return cache.get(id)
    const parts = []
    let cur = byId.get(id)
    let depth = 0
    while (cur && depth++ < MAX_DEPTH) {
      parts.unshift(cur.name)
      cur = cur.parent_id ? byId.get(cur.parent_id) : null
    }
    cache.set(id, parts)
    return parts
  }
  const pathOf = (id) => chainOf(id).join(" / ")
  const ancestorPathOf = (id) => chainOf(id).slice(0, -1).join(" / ")

  /**
   * 某个知识点的全部后代 id（不含自己）。
   *
   * 用途：改父级时要把"自己和自己的后代"从候选里去掉——服务端 validate_tag
   * 有成环守卫会拒，但把注定被拒的选项摆出来，等于让人点了才吃一个报错。
   * visited 防脏数据成环。
   */
  const descendantIds = (id) => {
    const out = new Set()
    if (!id) return out
    const childrenOf = new Map()
    for (const t of tags ?? []) {
      if (t.parent_id) {
        const list = childrenOf.get(t.parent_id) ?? []
        list.push(t.id)
        childrenOf.set(t.parent_id, list)
      }
    }
    const stack = [...(childrenOf.get(id) ?? [])]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (out.has(cur) || cur === id) continue
      out.add(cur)
      for (const child of childrenOf.get(cur) ?? []) stack.push(child)
    }
    return out
  }

  return { byId, pathOf, ancestorPathOf, descendantIds }
}

/**
 * 某个科目节点（含其子树）下可见的知识点。
 *
 * 三条规则，缺一条都会让"学科隔离"漏：
 *   · 没给学科上下文（subjectNodeId 为空）→ **不过滤**，返回全部。
 *     调用方不知道学科时（例如公共的题库筛选）硬按 null 过滤会把列表清空，
 *     那不是隔离，是坏掉。
 *   · 标签自己没归类（subject_node_id 为 null）→ **不返回**。
 *     未归类的标签是"等管理员指派"的中间态，让它出现在某个学科的题上，
 *     等于隔离还没建立就先漏了；它在管理页可见、可指派。
 *   · 其余按 subject_node_id 是否落在该节点的子树里判断。
 */
export function tagsInScope(tags, subjectNodeId, nodes) {
  const all = tags ?? []
  if (!subjectNodeId) return all
  const allowed = new Set(subtreeIdsOf(nodes ?? [], subjectNodeId))
  return all.filter((t) => t.subject_node_id && allowed.has(t.subject_node_id))
}

/** 未归类的知识点（管理页要专门列出来等人指派）。 */
export function unassignedTags(tags) {
  return (tags ?? []).filter((t) => !t.subject_node_id)
}
