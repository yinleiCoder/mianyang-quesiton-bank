// 参考数据缓存的失效入口（背景与"为什么必须显式喊一声"见 lib/reference-data.js 头注）。
//
// 为什么是 updateTag 而不是 revalidateTag(tag, "max")：前者**立即过期**，下一次读阻塞取新数据
// （read-your-own-writes）；后者是纯 SWR —— 过期后第一次读仍发旧值，且不带 re-render。
// 管理员刚建好的科目节点，就是要"下一个页面立刻选得到"，只有前者做得到。
//
// 鉴权：Server Action 不经过根 proxy.ts 的路径守卫（见 lib/actions/auth.js 头注），
// 所以自己闸一道 —— 这里只要求"登录了"（requireSession 是本地验签，零网络往返）。
// 不按资源细分角色：它能做的只有把缓存标签标记过期，下一次读重新查一张十几行的表；
// **真正的写权限在 SQL 里**（admin_* 系列与 create_tag 各自的守卫），在这里再抄一遍角色表，
// 只会多一个"新增了合法写入方却忘了加角色 → 静默退回 TTL"的坑。
// 全程不抛业务错误 —— 喊丢了还有 TTL 兜底，不该把已经写成功的操作弹成错误。
"use server"

import { updateTag } from "next/cache"
import { requireSession } from "@/lib/auth"
import { REFERENCE_TAGS } from "@/lib/reference-data"

export async function refreshReference(resource) {
  const tag = REFERENCE_TAGS[resource]
  if (!tag) return { ok: false }
  await requireSession()
  updateTag(tag)
  return { ok: true }
}
