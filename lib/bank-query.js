// 题库筛选的查询参数口径：服务端页面解析、客户端筛选条改写、分页链接共用一份键表，
// 新增筛选项只需改本文件（页面查询与筛选控件同步生效）。

export const BANK_FILTER_KEYS = ["kw", "node", "qtype", "diff", "tag"]

// searchParams → 规范化筛选值（非法值一律回落默认，页面无需再逐项判类型）
export function parseBankFilters(searchParams = {}) {
  const str = (v) => (typeof v === "string" ? v : "")
  const page = Number.parseInt(str(searchParams.page), 10)
  const diff = str(searchParams.diff)
  return {
    kw: str(searchParams.kw).trim(),
    node: str(searchParams.node),
    qtype: str(searchParams.qtype),
    diff: /^[1-3]$/.test(diff) ? diff : "",
    tag: str(searchParams.tag),
    page: Number.isFinite(page) && page > 1 ? page : 1,
  }
}

export const hasBankFilters = (value) => BANK_FILTER_KEYS.some((k) => value?.[k])

// 筛选值 → 查询串（空值不落参数；page 缺省即第一页）
export function bankQueryString(value = {}, page = 1) {
  const sp = new URLSearchParams()
  for (const key of BANK_FILTER_KEYS) if (value[key]) sp.set(key, value[key])
  if (page > 1) sp.set("page", String(page))
  return sp.toString()
}
