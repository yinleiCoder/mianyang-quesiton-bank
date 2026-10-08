import Fuse from "fuse.js"

// 模糊搜索的统一口径（Fuse.js）。包一层的原因：
//   · 阈值这类参数散在各处，调一次要翻十个文件；
//   · Fuse 的默认阈值 0.6 对**中文短词**太宽松 —— 搜"办公"能 match 出一串无关节点，
//     这里收到 0.35（宁少勿滥：选择器里出现一堆不对的东西比少几条更烦人）；
//   · ignoreLocation 必须开：默认只在前 60 个字符里找，中文路径（"计算机 / 办公应用"）
//     很容易把关键词挤出这个窗口，表现成"明明有却搜不到"。
//
// **什么时候该用 Fuse、什么时候别用**：
//   · 用它：列表**已经在客户端全量**、且用户是"记不全/打得不准"地找东西
//     （科目节点、标签、人、试卷标题）——跨字段、词序不同、多字少字都能命中；
//   · 别用它：**服务端分页的大列表**（题库几千条）。客户端手里只有当前一页，
//     在上面做模糊匹配会得到"这一页里恰好匹配的几条"，比不做更糟。
//     那种场景归 ILIKE + 防抖（见 components/papers/question-picker.jsx）。
//
// 节流：搜索框的输入一律先过 lib/use-debounced.js 的 useDebounced 再喂进来。

export const FUSE_THRESHOLD = 0.35

export function createFuse(list, keys, options = {}) {
  return new Fuse(list ?? [], {
    keys,
    threshold: FUSE_THRESHOLD,
    ignoreLocation: true,
    minMatchCharLength: 1,
    ...options,
  })
}

/** 查一次。空查询返回 []（**不是全量** —— 调用方靠空查询切回"树/全列表"的渲染分支）。 */
export function searchFuse(fuse, query, limit = 50) {
  const q = (query ?? "").trim()
  if (!q || !fuse) return []
  return fuse.search(q, { limit }).map((r) => r.item)
}
