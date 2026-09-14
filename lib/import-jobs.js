// 批量导入的装载器与文案映射（服务端页面用；客户端只用到这里导出的标签表）。
// 可见性交给 RLS（本人 / 本校学校管理员 / 系统管理员），这里不做二次过滤。
//
// 失败一律抛 **Error（带中文消息）而不是原样的 PostgrestError**：后者是普通对象，
// 一旦成为未处理的 rejection，界面上只会显示成 {code, details, hint, message} 这种
// 没法读的东西（这个功能里已经踩过两次）。Error 至少能在任何地方显示出人话。

const fail = (what, error) =>
  new Error(`${what}失败：${error?.message ?? "未知错误"}${error?.code ? `（${error.code}）` : ""}`)

export const JOB_STATES = {
  running: { text: "解析中", cls: "bg-sky-100 text-sky-700" },
  review: { text: "待校对", cls: "bg-amber-100 text-amber-700" },
  importing: { text: "入库中", cls: "bg-violet-100 text-violet-700" },
  done: { text: "已完成", cls: "bg-emerald-100 text-emerald-700" },
  discarded: { text: "已放弃", cls: "bg-muted text-muted-foreground" },
}
export const jobStateChip = (s) => JOB_STATES[s] ?? { text: s, cls: "bg-muted text-muted-foreground" }

export const PAGE_STATES = {
  pending: { text: "待解析", cls: "bg-muted text-muted-foreground" },
  running: { text: "解析中", cls: "bg-sky-100 text-sky-700" },
  done: { text: "已完成", cls: "bg-emerald-100 text-emerald-700" },
  failed: { text: "失败", cls: "bg-rose-100 text-rose-700" },
  skipped: { text: "已跳过", cls: "bg-muted text-muted-foreground" },
}
export const pageStateChip = (s) => PAGE_STATES[s] ?? { text: s, cls: "bg-muted text-muted-foreground" }

// 解析出来的题需要人工注意的点。文案要具体——"低置信"这种说法教师看不懂该怎么办
export const FLAG_LABELS = {
  cross_page: { text: "跨页", hint: "这道题在页尾被截断或跨到了下一页，请核对是否完整" },
  merged_cross_page: { text: "已合并跨页", hint: "自动合并了跨页的两部分" },
  has_figure: { text: "含图", hint: "题干里有图（用 [[图N]] 占位），入库后到编辑器里补图" },
  has_formula: { text: "含公式", hint: "公式以 Unicode 近似表示，请核对" },
  answer_missing: { text: "缺答案", hint: "没抽到答案——这类题默认不入库，请补齐后再勾选" },
  blank_mismatch: { text: "空位不符", hint: "题干空位数与答案个数对不上，入库会被拒绝" },
  qno_gap: { text: "题号跳号", hint: "题号不连续，可能漏抽了题" },
  low_confidence: { text: "待核对", hint: "模型自评把握不大，或内容有结构性提示" },
  dup_in_job: { text: "卷内重复", hint: "与本任务里另一道题重复，已自动去重" },
  dup_in_bank: { text: "库里已有", hint: "题库里已有相似题目" },
  truncated: { text: "输出被截断", hint: "该页输出触到长度上限，末尾的题可能不全" },
  no_analysis: { text: "无解析", hint: "既没有原文解析、也没生成" },
  ai_analysis: { text: "AI 解析", hint: "解析是模型补写的，不是原卷内容" },
}

export const SOURCE_KINDS = { pdf: "PDF", docx: "Word", image: "图片" }

const JOB_COLUMNS =
  "id, created_by, school_id, course_node_id, title, source_kind, source_name, source_pages, " +
  "page_from, page_to, image_mode, image_detail, gen_analysis, default_qtype, default_difficulty, " +
  "tag_ids, status, total_pages, done_pages, failed_pages, item_count, kept_count, imported_count, " +
  "usage, last_error, created_at, finished_at"

/**
 * 历史任务列表。**不返回已放弃的任务**：放弃是软删（行留在库里做记录、已生成的草稿也留着），
 * 但对使用者来说它就该从列表里消失——否则放弃完还占着位置，反而更困惑。
 */
export async function loadImportJobs(supabase, limit = 30) {
  const res = await supabase
    .from("import_jobs")
    .select(JOB_COLUMNS)
    .neq("status", "discarded")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (res.error) throw fail("读取历史任务", res.error)
  return res.data ?? []
}

export async function loadImportJob(supabase, jobId) {
  const res = await supabase.from("import_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle()
  if (res.error) throw fail("读取任务", res.error)
  return res.data ?? null
}

export async function loadJobPages(supabase, jobId) {
  const res = await supabase
    .from("import_job_pages")
    .select("id, page_no, mode, status, attempts, tile_count, error, usage")
    .eq("job_id", jobId)
    .order("page_no")
  if (res.error) throw fail("读取任务进度", res.error)
  return res.data ?? []
}

const ITEM_COLUMNS =
  "id, page_no, page_no_end, seq, qno, qtype, difficulty, content, status, flags, confidence, " +
  "source_quote, note, error, question_id, version_id"

export async function loadJobItems(supabase, jobId, limit = 2000) {
  const res = await supabase
    .from("import_job_items")
    .select(ITEM_COLUMNS)
    .eq("job_id", jobId)
    .order("page_no")
    .order("seq")
    .limit(limit)
  if (res.error) throw fail("读取解析出的题目", res.error)
  return res.data ?? []
}

// 解析出的题在预览表里怎么显示：题干取纯文本，选项拼成一行
export function itemSummary(content) {
  const text = (content?.stem ?? [])
    .filter((b) => b?.t === "text")
    .map((b) => b.text)
    .join(" ")
    .trim()
  return text
}
