// 复习资料的数据装载与筛选口径（教师管理页 SSR seed 与客户端重查共用）。
//
// 权限判断**不在这里，也不在页面上**：review_materials 的 RLS 策略 rm_select 只放行
// 「已发布 或 我是作者」。前端拿不到越权数据不是因为这个模块筛过，而是因为 SQL 里筛过
// —— UI 不是安全边界（0069 的教训）。本模块只负责取数与失败表达。
//
// ⚠ 本模块会被 "use client" 组件引用（筛选条与删除确认），**绝不能 import next/cache**。

// LIKE 通配符转义。**同一段正则在 app/(app)/bank/page.jsx:26 与
// components/papers/question-picker.jsx:19 各有一份**（历史遗留），
// 这里导出第三份是权宜：至少新代码有共享点。将来收拾时以本处为唯一源，把那两处改 import。
export const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`)

// 资料类型。取值必须与 0070 的 review_materials_kind_check 约束逐字一致。
export const MATERIAL_KINDS = [
  { value: "pdf", label: "PDF" },
  { value: "word", label: "Word" },
  { value: "sheet", label: "Excel" },
  { value: "slide", label: "PPT" },
  { value: "image", label: "图片" },
  { value: "audio", label: "音频" },
  { value: "video", label: "视频" },
  { value: "other", label: "其他" },
]

// 卡片上那个类型标签的文案；认不出的 kind 回落到扩展名之外的中性词。
export function kindLabel(kind) {
  return MATERIAL_KINDS.find((k) => k.value === kind)?.label ?? "资料"
}

// 只有 PDF 与图片能在应用内直接看，其余（Office / 音视频）客户端是交给系统程序打开的。
// 这个判断两端都要用（网页端给提示文案、Flutter 端决定点开走哪条路），所以口径写在这里，
// 客户端那份见 mianyang_quiz/lib/data/models/material/material_brief.dart，两处必须一致。
export const INLINE_KINDS = ["pdf", "image"]

// 「这个格式学生点开是直接看还是交给系统程序」，用于上传时的提示与列表上的角标。
export function opensInline(kind) {
  return INLINE_KINDS.includes(kind)
}

// 筛选的查询参数口径：服务端页面解析、客户端筛选条改写、分页链接共用一份键表
//（与 lib/bank-query.js / lib/students.js 同构）。新增筛选项只改这里。
export const MATERIAL_FILTER_KEYS = ["kw", "node", "kind", "mine"]

export function parseMaterialFilters(searchParams = {}) {
  const str = (v) => (typeof v === "string" ? v : "")
  const page = Number.parseInt(str(searchParams.page), 10)
  const kind = str(searchParams.kind)
  return {
    kw: str(searchParams.kw).trim(),
    node: str(searchParams.node),
    // 非法 kind 一律回落"不限"，页面无需再逐项判类型
    kind: MATERIAL_KINDS.some((k) => k.value === kind) ? kind : "",
    mine: str(searchParams.mine) === "1",
    page: Number.isFinite(page) && page > 1 ? page : 1,
  }
}

export const hasMaterialFilters = (value) =>
  MATERIAL_FILTER_KEYS.some((k) => value?.[k])

export function materialQueryString(value = {}, page = 1) {
  const sp = new URLSearchParams()
  if (value.kw) sp.set("kw", value.kw)
  if (value.node) sp.set("node", value.node)
  if (value.kind) sp.set("kind", value.kind)
  if (value.mine) sp.set("mine", "1")
  if (page > 1) sp.set("page", String(page))
  return sp.toString()
}

// 字段失败一律返回 null（不是空数组）——与 lib/students.js 同约定：
// null = "这次没查成，保留旧值"，空数组 = "查成了，就是空的"。
// 两者混为一谈会让一次网络抖动把整张表清空。
export async function loadMaterials(
  supabase,
  { nodeIds = null, kind = null, keyword = "", mineOnly = false, userId = null, page = 1, pageSize = 24 } = {}
) {
  // 学科筛的是**子树**：资料可以挂在任意层级，选了「计算机」（专业大类）就该看到
  // 挂在它下面「信息技术」（课程）上的资料。展开交给调用方——整棵树它已经拿在手里，
  // 这里再查一次是白跑一趟（与题库页同样的分工）。
  // 展开结果为空集时直接短路，不必发请求。
  if (nodeIds && nodeIds.length === 0) return { rows: [], total: 0, error: null }

  let query = supabase
    .from("review_materials")
    .select(
      "id, object_key, bucket, size, mime, title, description, kind, course_node_id, " +
        "creator_id, school_id, download_count, is_published, created_at, schools(name)",
      { count: "exact" }
    )

  if (nodeIds) query = query.in("course_node_id", nodeIds)
  if (kind) query = query.eq("kind", kind)
  // search_text 是生成列（标题 + 简介，已 lower）。ilike 本身不区分大小写，
  // 这里仍转小写只是为了与生成列的存储形态对齐。
  if (keyword) query = query.ilike("search_text", `%${escapeLike(keyword.toLowerCase())}%`)
  if (mineOnly && userId) query = query.eq("creator_id", userId)

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  if (error) return { rows: null, total: 0, error }

  const rows = data ?? []
  // 上传人姓名要单独查：review_materials.creator_id 指向 auth.users，与 profiles 之间
  // **没有外键**，PostgREST 嵌入不了（学校有外键，所以 schools(name) 能直接嵌）。
  // profiles 对所有登录用户可读（策略 select_any_auth），这是全仓一致的取名字手法。
  const ids = [...new Set(rows.map((r) => r.creator_id).filter(Boolean))]
  const { data: people } = ids.length
    ? await supabase.from("profiles").select("user_id, name").in("user_id", ids)
    : { data: [] }
  const nameById = new Map((people ?? []).map((p) => [p.user_id, p.name]))

  return {
    rows: rows.map((r) => ({
      ...r,
      creator_name: nameById.get(r.creator_id) ?? null,
      // 上传人注销后 creator_id 置空（on delete set null），姓名也随之消失 —— 内容仍在
      school_name: r.schools?.name ?? null,
    })),
    total: count ?? 0,
    error: null,
  }
}
