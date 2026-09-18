// 学生名册与学情的数据装载（服务端 SSR seed 与客户端重查共用，保证两处口径一致）。
//
// 与 /admin/users 的分工**互斥且互补**：identity='student' 只出现在本模块驱动的那一页，
// 其余身份（教师 / 教师待审核 / 管理员）只出现在用户与任命。学生转教师（0025
// review_teacher_identity）后自动换边 —— 两边都不要写"顺便也查一下"的兜底，那会把这个不变量打破。
//
// 权限判断**不在这里**：list_my_students / my_student_detail 都是 SECURITY DEFINER，
// 内部用 can_view_student 逐行过滤（系统管理员=全部 / 学校管理员=本校 / 教师=本校本专业）。
// 前端拿不到越权数据不是因为这里筛过，而是因为 SQL 里筛过 —— UI 不是安全边界（0059 的教训）。
// 本模块只负责取数与失败表达。
//
// ⚠ 本模块会被 "use client" 组件引用（名册的筛选与批量归班），**绝不能 import next/cache**。
//   参考数据（学校 / 科目树 / 班级）由服务端页面取好传进来 —— 见 lib/reference-data.js 顶部黑名单。

// 字段失败一律返回 null（不是空数组）—— 与 lib/admin-users.js 同约定：
// 客户端重查时 null = "这次没查成，保留旧值"，空数组 = "查成了，就是空的"。
// 两者混为一谈会让一次网络抖动把整张表清空。

export async function loadStudentRoster(
  supabase,
  { classId = null, onlyUnassigned = false, keyword = "", page = 1, pageSize = 50 } = {}
) {
  const { data, error } = await supabase.rpc("list_my_students", {
    p_class_id: classId,
    p_only_unassigned: onlyUnassigned,
    p_keyword: keyword || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  })
  if (error) return { rows: null, total: 0, error }
  const rows = data ?? []
  // total_count 是 count(*) over () 窗口列，每行都带着同一份总数
  return { rows, total: Number(rows[0]?.total_count ?? 0), error: null }
}

// 班级下拉：只列调用者能看到的班级（教师看本专业，学校管理员看本校）。
export async function loadMyClassOptions(supabase) {
  const { data, error } = await supabase.rpc("list_my_student_classes")
  if (error) return { classes: null, error }
  return { classes: data ?? [], error: null }
}

// 单个学生的完整学情。无权时 RPC 抛 42501（PostgREST 原样透传 SQLSTATE）。
export async function loadStudentDetail(supabase, studentId) {
  const { data, error } = await supabase.rpc("my_student_detail", { p_student_id: studentId })
  if (error) return { detail: null, denied: error.code === "42501", error }
  return { detail: data, denied: false, error: null }
}

// 就读年份的展示口径：2024 → 24 级（0032 的列注释定下的，别在别处另写一套）
export function gradeLabel(enrollYear) {
  if (!enrollYear) return null
  return `${String(enrollYear).slice(-2)} 级`
}

// 正确率：分母是**客观题数**（graded_count），不是答题总数 —— 主观自评题的 is_correct 恒为 null，
// 混进去会把正确率压低（口径同 RPC 里的 graded_count，见 0063）。没有客观题作答时返回 null，
// 调用方显示「—」而不是 0%（0 次 ≠ 全错）。
export function accuracyPercent({ correct_count, graded_count }) {
  const g = Number(graded_count) || 0
  if (g <= 0) return null
  return `${Math.round(((Number(correct_count) || 0) / g) * 100)}%`
}

// 名册筛选的查询参数口径：服务端页面解析、客户端筛选条改写、分页链接共用一份键表
//（与 lib/bank-query.js 同构）。新增筛选项只改这里。
export const STUDENT_FILTER_KEYS = ["class", "unassigned", "kw"]

export function parseStudentFilters(searchParams = {}) {
  const str = (v) => (typeof v === "string" ? v : "")
  const page = Number.parseInt(str(searchParams.page), 10)
  return {
    classId: str(searchParams.class),
    // 未分班是个独立维度，不是"某个班级"：学生没班级时 class 为空，
    // 不能靠 class=="" 兼表两义（那样就没法表达"不过滤"）。
    onlyUnassigned: str(searchParams.unassigned) === "1",
    kw: str(searchParams.kw).trim(),
    page: Number.isFinite(page) && page > 1 ? page : 1,
  }
}

export const hasStudentFilters = (value) =>
  Boolean(value?.classId) || Boolean(value?.onlyUnassigned) || Boolean(value?.kw)

// 筛选值 → 查询串（空值不落参数；page 缺省即第一页）
export function studentQueryString(value = {}, page = 1) {
  const sp = new URLSearchParams()
  if (value.classId) sp.set("class", value.classId)
  if (value.onlyUnassigned) sp.set("unassigned", "1")
  if (value.kw) sp.set("kw", value.kw)
  if (page > 1) sp.set("page", String(page))
  return sp.toString()
}
