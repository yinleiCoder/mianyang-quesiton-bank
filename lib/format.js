// 时间展示/序列化统一口径（同构模块：Server/Client 均可 import）。
// 全库只有这几种格式：日期、24 小时制日期时间、本地化日期时间、ISO（跨端传递用）。
// 空值一律返回空串（toISO 返回 null），调用方无需再判空。

export const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("zh-CN") : "")

export const fmtDateTime = (s) => (s ? new Date(s).toLocaleString("zh-CN") : "")

export const fmtDateTime24 = (s) =>
  s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : ""

// 服务端 → 客户端传值：Date 对象不可序列化，统一转 ISO
export const toISO = (s) => (s ? new Date(s).toISOString() : null)
