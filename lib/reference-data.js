// 用户无关的参考数据（科目树 / 学校名单）的唯一读入口，外面包一层 unstable_cache。
//
// 为什么能缓存：这两份数据与调用者身份无关（RLS 对 anon 与 authenticated 都是 using(true)），
// 不含个人信息，且规模极小（库里当前：学校 9 行、科目节点 8 行）。而它们几乎每个页面都在读，
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
// 失效策略：只靠 TTL，不挂 revalidateTag。参考数据的写入全部发生在浏览器端
//（components/admin/{tags,schools,tree}-manager.jsx 用浏览器 Supabase 客户端调 RPC），
// 服务端从头到尾观察不到；且三个管理器都是「操作成功后自己重查」，不依赖 SSR 新鲜度。
// 所以没有可达的 revalidateTag 调用点 —— tags 先留着，将来真有了服务端写入路径
// 直接 revalidateTag("reference:xxx", "max") 即可生效（Next 16 双参签名，单参已废弃）。
import { unstable_cache } from "next/cache"
import { createPublicClient } from "@/lib/supabase/public"
import { SUBJECT_NODE_COLUMNS } from "@/lib/subject-nodes"

// 参考数据的改动都来自管理后台的低频人工操作，5 分钟窗口内用户看不出差别。
const TTL_SECONDS = 300

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
  ["reference:subject-nodes"],
  { revalidate: TTL_SECONDS, tags: ["reference:subject-nodes"] }
)

// 列取超集（id/name/code/is_active）：注册页要按 is_active 过滤，管理端要 is_active，
// 其余场景只用 id→name 映射，多带两列比按调用方分多个缓存键更划算。
export const loadSchools = unstable_cache(
  async () => {
    const { data, error } = await createPublicClient()
      .from("schools")
      .select("id, name, code, is_active")
      .order("name")
    if (error) throw error
    return data ?? []
  },
  ["reference:schools"],
  { revalidate: TTL_SECONDS, tags: ["reference:schools"] }
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
  ["reference:tags"],
  { revalidate: TTL_SECONDS, tags: ["reference:tags"] }
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
  ["reference:classes"],
  { revalidate: TTL_SECONDS, tags: ["reference:classes"] }
)

// id → name 映射：调用方拿到的往往是 school_id，要显示成人看的名字。
// 找不到时返回 null（调用方自己决定显示占位还是留空）。
export function schoolNameOf(schools, id) {
  if (!id) return null
  return schools.find((s) => s.id === id)?.name ?? null
}
