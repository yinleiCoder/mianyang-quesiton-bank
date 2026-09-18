// 题目打印页：干净的一页纸，供浏览器「打印 → 另存为 PDF」。
//
// 为什么不做服务端生成 PDF：中文排版要嵌字体（几 MB 起步）、公式/图片/表格还得逐个实现，
// 而浏览器自带的打印引擎这些全都现成，学生/老师在打印对话框里选「另存为 PDF」就是 PDF。
// 所以这里只做一件事——把页面上与打印无关的东西全部去掉，并把版式调成 A4 友好。
//
// 不进 (app) 路由组：那边有侧栏与页头，打印时会一起印出来。
// 仍然调 requireUser()：打印的是题库内容，不该匿名可读。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { indexNodes } from "@/lib/subject-nodes"
import { loadSchools, loadSubjectNodes } from "@/lib/reference-data"
import { loadPeople } from "@/lib/people"
import { QuestionReader } from "@/components/bank/question-reader"
import { PrintButton } from "@/components/print-button"
import { AccessDenied } from "@/components/access-denied"

export const metadata = { title: "打印题目" }

export default async function PrintQuestionPage({ params }) {
  const { id } = await params
  await requireUser()
  const supabase = await createClient()

  const { data: q, error: qError } = await supabase
    .from("questions")
    .select("id, school_id, course_node_id, creator_id, state, current_published_version_id")
    .eq("id", id)
    .maybeSingle()
  if (qError) throw qError
  if (!q || q.state !== "live" || !q.current_published_version_id) {
    return (
      <AccessDenied
        title="题目不可见"
        description="这道题可能尚未入库、正在审核中，或已被下线，因此不能打印。"
      />
    )
  }

  const [vRes, nodes, schoolRes, tagRes, apprRes] = await Promise.all([
    supabase
      .from("question_versions")
      .select("id, version_no, qtype, difficulty, content, published_at, created_by")
      .eq("id", q.current_published_version_id)
      .single(),
    loadSubjectNodes(),
    supabase.from("schools").select("id, name").eq("id", q.school_id).maybeSingle(),
    supabase.from("version_tags").select("tag_name").eq("version_id", q.current_published_version_id),
    supabase.rpc("bank_reviewers", { p_version_ids: [q.current_published_version_id] }),
  ])
  for (const r of [vRes, schoolRes, tagRes, apprRes]) if (r.error) throw r.error
  const v = vRes.data
  const { pathOf: nodePath } = indexNodes(nodes)
  const tags = (tagRes.data ?? []).map((t) => t.tag_name)

  const approvedBy = (apprRes.data ?? []).filter((a) => a.decided_by)
  const people = await loadPeople(
    supabase,
    [v.created_by, ...approvedBy.map((a) => a.decided_by)],
    await loadSchools()
  )
  const author = v.created_by ? people.get(v.created_by) : null
  const reviewers = approvedBy
    .map((a) => `${a.stage === "group" ? "组长" : "专家"} ${people.get(a.decided_by)?.name ?? ""}`.trim())
    .filter(Boolean)

  return (
    <div className="mx-auto max-w-[820px] bg-white p-8 text-black print:p-0">
      <PrintButton />

      <header className="mb-4 border-b border-black/20 pb-3">
        <h1 className="text-lg font-semibold">绵阳市中职共建题库 · 题目打印</h1>
        <p className="mt-1 text-xs text-black/70">
          {nodePath(q.course_node_id) || "未选节点"}
          {schoolRes.data?.name ? ` · 题源：${schoolRes.data.name}` : ""}
          {author ? ` · 作者：${author.name}` : ""}
          {reviewers.length > 0 ? ` · 审核：${reviewers.join("、")}` : ""}
        </p>
        <p className="mt-1 text-xs text-black/70">
          {qtypeLabel(v.qtype)} · 难度 {difficultyLabel(v.difficulty)} · 第 {v.version_no} 版
          {tags.length > 0 ? ` · 标签：${tags.join("、")}` : ""}
        </p>
      </header>

      {/* 打印版要带答案与解析：复印出来是为了做题与讲评 */}
      <QuestionReader qtype={v.qtype} content={v.content} />

      <footer className="mt-6 border-t border-black/20 pt-2 text-[10px] text-black/50">
        绵阳市中职共建题库 · 本题为全市共享题目，内容经两级审核入库
      </footer>
    </div>
  )
}
