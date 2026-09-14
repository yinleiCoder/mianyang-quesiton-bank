// 批量导入（教师）：PDF / Word / 图片 → 大模型解析 → 人工校对 → 批量生成草稿。
// 任务数据与页进度都在数据库里，刷新/关页面不丢；只有源文件留在浏览器内存。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { isAttachable, subjectNodesQuery } from "@/lib/subject-nodes"
import { loadImportJob, loadImportJobs, loadJobItems, loadJobPages } from "@/lib/import-jobs"
import { ImportPage } from "@/components/import/import-page"
import { AccessDenied } from "@/components/access-denied"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { FileUpIcon } from "lucide-react"

export const metadata = { title: "AI智能解析题库资料" }

export default async function ImportQuestionPage({ searchParams }) {
  const ctx = await requireUser()
  if (!ctx.isTeacher) {
    return (
      <AccessDenied
        title="仅教师可用"
        description="AI 解析会生成你名下的草稿，仅审核通过的教师（以及系统管理员）可用。"
      />
    )
  }

  const supabase = await createClient()
  const { data: nodes, error } = await subjectNodesQuery(supabase, { sorted: true })
  if (error) throw error
  // 只用来判断"有没有能挂题的节点"。
  // **传给选择器的必须是全量节点**：专业课程挂在「专业大类 → 专业」下面，
  // 只传课程的话它们在树里找不到父级、整枝消失（选择器自己会把不可挂题的节点标灰）。
  const pickable = (nodes ?? []).filter((n) => isAttachable(n.kind) && !n.is_frozen)

  if (pickable.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="AI智能解析题库资料"
          description="把现成的试卷、讲义交给模型解析，人工校对后批量生成草稿。"
        />
        <EmptyState
          icon={FileUpIcon}
          title="还没有可挂题的科目节点"
          description="题目必须挂在「公共学科」或「课程」节点下。请先让系统管理员在科目树里建好节点。"
        />
      </div>
    )
  }

  const sp = (await searchParams) ?? {}
  const jobId = typeof sp.job === "string" ? sp.job : null

  // 历史任务列表总是要的；指定了 job 时再把它连同页/题一起取出来（服务端首屏，避免白屏）
  const jobs = await loadImportJobs(supabase)
  let initial = null
  if (jobId) {
    const [job, pages, items] = await Promise.all([
      loadImportJob(supabase, jobId),
      loadJobPages(supabase, jobId),
      loadJobItems(supabase, jobId),
    ])
    // 越权访问不报错，回落到向导（RLS 已经挡住数据了）
    if (job) initial = { job, pages, items }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="AI智能解析题库资料"
        description="支持 PDF、Word(.docx) 与图片。文件不会上传——只把你选中的那几页渲染后交给模型，解析结果先经你校对，确认后才生成草稿。"
      />
      <ImportPage nodes={nodes ?? []} jobs={jobs} initial={initial} />
    </div>
  )
}
