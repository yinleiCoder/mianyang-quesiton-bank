// 用户无关的参考数据（科目树 / 学校名单）的唯一读入口，外面包一层 unstable_cache。
//
// 为什么能缓存：这两份数据与调用者身份无关（RLS 对 anon 与 authenticated 都是 using(true)），
// 不含个人信息，且规模极小（每张表都是个位数到十几行）。而它们几乎每个页面都在读，
// 每次读都是一次 170–460ms 的 Supabase 往返 —— 缓存掉的是纯重复开销。
//
// 为什么是 unstable_cache 而不是 'use cache'：本项目没开 cacheComponents
//（next.config.mjs 只有 reactCompiler），'use cache' 在当前配置下不可用。
//
// ⚠ 本模块 import 了 next/cache，**绝不能被任何 "use client" 模块（直接或间接）引用**。
//   已知会被打进客户端的模块：lib/question-workbench.js、lib/review-workbench.js、
//   lib/admin-users.js、lib/admin-records.js、lib/people.js
//   （后者经 lib/feedback.js ← components/admin/feedback-inbox.jsx）。
//   它们要拿参考数据，只能由服务端页面取好后传进去，不能自己 import 本模块。
//
// 失效策略：TTL 只是兜底，写入方**必须**显式喊一声 —— 写成功后调用
// lib/actions/reference.js 的 refreshReference（客户端便捷包装见 lib/reference-refresh.js），
// 它用 updateTag 把对应 tag 立即作废。
//
// 为什么必须显式（2026-10-14 的教训）：参考数据的写入全部发生在浏览器端
//（components/admin/{tree,tags,schools,classes}-manager.jsx 用浏览器 Supabase 客户端调 RPC），
// 服务端从头到尾观察不到。原以为「管理器操作成功后自己重查就够了」——那只够它自己那一页：
// 管理员建完「汽修」专业，本页立刻看得到（浏览器直查），**别的页面**（出题、题库、班级）
// 却继续读这份缓存，最长 5 分钟，而且过期后第一次访问仍发旧值（时间过期是 SWR：
// 先发旧的、后台再换新的），体感就是「建是建了，到处都选不到」。
//
// ⚠ 别换回 revalidateTag("…", "max")：那个 profile 是纯 SWR，过期后第一次读照样发旧数据，
//   而且不带 re-render（Server Action 的响应里不会有新页面）。要的就是 updateTag 的
//   「立即过期 + 下一次读阻塞取新」（read-your-own-writes，docs 里 updateTag 那一节）。
import { unstable_cache } from "next/cache"
import { createPublicClient } from "@/lib/supabase/public"
import { SUBJECT_NODE_COLUMNS } from "@/lib/subject-nodes"

// 参考数据的改动都来自管理后台的低频人工操作。**这是兜底**：正常路径是写入后立即 updateTag
//（见上），5 分钟只是"那一声没喊到"时的最坏恢复时间。
const TTL_SECONDS = 300

// 缓存键与失效 tag（两者刻意取同一个串）。键名同时是 refreshReference 的参数，
// 改名要连 lib/actions/reference.js 的调用点一起改。
export const REFERENCE_TAGS = {
  subjectNodes: "reference:subject-nodes",
  schools: "reference:schools",
  tags: "reference:tags",
  classes: "reference:classes",
}

export const loadSubjectNodes = unstable_cache(
  async () => {
    const { data, error } = await createPublicClient()
      .from("subject_nodes")
      .select(SUBJECT_NODE_COLUMNS)
      .order("sort_order")
      .order("name")
    // 查询失败要抛出：空列表会被误认为「树是空的」，宁可报错。
    // 抛错不会写进缓存，下次请求会重试 —— 正是我们要的。
    if (error) throw error
    return data ?? []
  },
  [REFERENCE_TAGS.subjectNodes],
  { revalidate: TTL_SECONDS, tags: [REFERENCE_TAGS.subjectNodes] }
)

// 列取超集（id/name/code/is_active/city_id）：注册页要按 is_active 过滤，管理端要 is_active，
// 题库卡片要 city_id 去找市名，其余场景只用 id→name 映射，多带几列比按调用方分多个缓存键更划算。
// 这几个列 anon 都读得到（0007 给的是表级授权，不是列级的——见下面 loadTags 的反例）。
export const loadSchools = unstable_cache(
  async () => {
    const { data, error } = await createPublicClient()
      .from("schools")
      .select("id, name, code, is_active, city_id")
      .order("name")
    if (error) throw error
    return data ?? []
  },
  [REFERENCE_TAGS.schools],
  { revalidate: TTL_SECONDS, tags: [REFERENCE_TAGS.schools] }
)

// 标签字典（/bank 的筛选条等）。anon 的列级授权只放行 (id, name)（见 0040），
// 多 select 一列就会 permission denied —— 别在这里加 created_by。
export const loadTags = unstable_cache(
  async () => {
    const { data, error } = await createPublicClient()
      .from("tags")
      .select("id, name")
      .order("name")
    if (error) throw error
    return data ?? []
  },
  [REFERENCE_TAGS.tags],
  { revalidate: TTL_SECONDS, tags: [REFERENCE_TAGS.tags] }
)

// 班级名单（0063）。与 schools 同性质：学校排课的公开元数据，不含个人信息，anon 也能读
// （注册页在登录前就要选班级）。规模同样极小，缓存口径与上面三个一致。
//
// 注意它**不按学校分缓存键**：缓存的是全量，调用方自己按 school_id 筛 —— 同一所学校会被
// 注册页、名册页、管理页各读一次，按学校分键只会把同一份数据缓存很多遍。
//
// **与上面三个不同，这里失败返回空数组而不是抛出**：班级是"锦上添花"的可选信息，
// 选不了班级的学生照样能注册（服务端 handle_new_user 也会把取不到的 class_id 静默丢弃，
// 学生落「未分班」由管理员事后归班）。抛出去会把整张注册页打成错误页 —— 一个次要信息
// 不该有这种杀伤力。空数组在注册页的语义是"该校还没建班"，与"查询失败"给出的是同一句提示，
// 所以这里吞掉错误不会误导用户。
export const loadClasses = unstable_cache(
  async () => {
    const { data, error } = await createPublicClient()
      .from("classes")
      .select("id, school_id, major_node_id, name, is_active")
      .order("name")
    if (error) return []
    return data ?? []
  },
  [REFERENCE_TAGS.classes],
  { revalidate: TTL_SECONDS, tags: [REFERENCE_TAGS.classes] }
)

// id → name 映射：调用方拿到的往往是 school_id，要显示成人看的名字。
// 找不到时返回 null（调用方自己决定显示占位还是留空）。
export function schoolNameOf(schools, id) {
  if (!id) return null
  return schools.find((s) => s.id === id)?.name ?? null
}

// 市字典（id → 市名）。**只能传已登录的客户端**，不能走上面那条 createPublicClient 缓存路径：
// cities 对 anon 是关的（0082 刻意如此，全库对 anon 开放的表越少越好），
// 拿 anon 去查会 permission denied。表里只有几行，调用方把它并进自己的 Promise.all 即可，
// 不会多一次串行往返。
export async function loadCityMap(supabase) {
  const { data, error } = await supabase.from("cities").select("id, name")
  if (error) throw error
  return new Map((data ?? []).map((c) => [c.id, c.name]))
}

// 学校 → 所属市名（题库卡片的「题源 / 市区」两行就靠它俩）。
// 学校没有市（0082 之前建的老数据）时返回 null，调用方按"没有就不显示"处理。
export function schoolCityOf(schools, cityMap, id) {
  if (!id) return null
  const school = schools.find((s) => s.id === id)
  return (school?.city_id && cityMap.get(school.city_id)) || null
}
