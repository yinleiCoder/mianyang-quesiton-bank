// 试卷详情：只读整卷 + 状态 + 操作入口。
// 预览按**正卷**渲染（不含答案与解析）——答案走独立的打印路由，
// 免得学生在网页上直接看到答案。教师需要答案时点「打印答案」。
import Link from "next/link"
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperVersion, loadPaperHealth, HEALTH_LABEL, paperStatusChip } from "@/lib/paper-workbench"
import { loadSubjectNodes } from "@/lib/reference-data"
import { indexNodes } from "@/lib/subject-nodes"
import { loadPeople } from "@/lib/people"
import { fmtDate } from "@/lib/format"
import { round2 } from "@/lib/paper-model"
import { PaperSheet } from "@/components/papers/paper-sheet"
import { PaperActions } from "@/components/papers/paper-actions"
import { AccessDenied } from "@/components/access-denied"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PrinterIcon, FileCheckIcon, ArrowLeftIcon, AlertTriangleIcon, ClipboardCheckIcon } from "lucide-react"

export async function generateMetadata({ params }) {
  const { id } = await params
  return { title: `试卷 ${id.slice(0, 8)}` }
}

export default async function PaperDetailPage({ params }) {
  const { id } = await params
  await requireUser()
  const ctx = await getAuthContext()
  const supabase = await createClient()

  const { data: paper, error } = await supabase
    .from("papers")
    .select("id, state, creator_id, school_id, course_node_id, current_published_version_id, created_at")
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  if (!paper) {
    return <AccessDenied title="试卷不存在" description="它可能已被删除，或链接有误。" />
  }

  // 优先展示当前入库版；还没入库（草稿/在审）就展示最新的那一版
  let versionId = paper.current_published_version_id
  if (!versionId) {
    const { data: latest } = await supabase
      .from("paper_versions")
      .select("id")
      .eq("paper_id", id)
      .order("version_no", { ascending: false })
      .limit(1)
      .maybeSingle()
    versionId = latest?.id
  }
  if (!versionId) {
    return <AccessDenied title="试卷还没有内容" description="这份试卷没有任何版本。" />
  }

  const [snapshot, health, nodes, people] = await Promise.all([
    loadPaperVersion(supabase, versionId),
    loadPaperHealth(supabase, versionId),
    loadSubjectNodes(),
    loadPeople(supabase, [paper.creator_id]),
  ])
  const { pathOf } = indexNodes(nodes)
  const chip = paperStatusChip(snapshot.status)
  const isOwner = paper.creator_id === ctx.user?.id

  // 是否还有在流版本（决定「发起改版」能不能点）
  const { count: inFlight } = await supabase
    .from("paper_versions")
    .select("id", { count: "exact", head: true })
    .eq("paper_id", id)
    .in("status", ["draft", "pending_group", "pending_city", "returned"])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Button variant="ghost" size="sm" className="-ml-2" nativeButton={false} render={<Link href="/papers" />}>
            <ArrowLeftIcon className="size-4" /> 组卷库
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            {snapshot.title}
            <span className={`ml-2 align-middle rounded px-1.5 py-0.5 text-xs font-normal ${chip.cls}`}>
              {chip.text}
            </span>
            {paper.state === "offline" && (
              <Badge variant="secondary" className="ml-1 align-middle font-normal">
                已下线
              </Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {snapshot.exam_name ? `${snapshot.exam_name} · ` : ""}
            {pathOf(paper.course_node_id) || "未选科目"}
            {people.get(paper.creator_id)?.name ? ` · 组卷：${people.get(paper.creator_id).name}` : ""}
            {snapshot.published_at ? ` · 入库于 ${fmtDate(snapshot.published_at)}` : ""}
          </p>
          <p className="text-sm">
            共 <b className="tabular-nums">{snapshot.items?.length ?? 0}</b> 题
            <span className="mx-2 text-muted-foreground">·</span>
            满分 <b className="tabular-nums">{round2(snapshot.total_score)}</b> 分
            <span className="mx-2 text-muted-foreground">·</span>
            考试时长 <b className="tabular-nums">{snapshot.duration_minutes}</b> 分钟
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 阅卷入口只给有权限的人（试卷作者/本校管理员/系统管理员）。
              真正的权限判断在 RPC 里，这里只是不给一个点了会被拒的入口 */}
          {snapshot.status === "published" && (isOwner || ctx.isSchoolAdmin || ctx.isAdmin) && (
            <Button variant="outline" nativeButton={false} render={<Link href={`/papers/${paper.id}/grading`} />}>
              <ClipboardCheckIcon className="size-4" /> 阅卷
            </Button>
          )}
          <Button variant="outline" nativeButton={false} render={<a href={`/print/paper/${versionId}`} target="_blank" rel="noreferrer" />}>
            <PrinterIcon className="size-4" /> 打印正卷
          </Button>
          {ctx.isTeacher && (
            <Button variant="outline" nativeButton={false} render={<a href={`/print/paper/${versionId}/answers`} target="_blank" rel="noreferrer" />}>
              <FileCheckIcon className="size-4" /> 打印答案
            </Button>
          )}
        </div>
      </div>

      <PaperActions
        paperId={paper.id}
        versionId={versionId}
        status={snapshot.status}
        isOwner={isOwner}
        isTeacher={ctx.isTeacher}
        hasInFlight={(inFlight ?? 0) > 0 && snapshot.status !== "draft" && snapshot.status !== "returned"}
        healthCount={health.size}
      />

      {health.size > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangleIcon className="size-4" />
            有 {health.size} 道题在题库里发生了变化
          </p>
          <ul className="mt-1 text-xs">
            {[...health.entries()].slice(0, 6).map(([itemId, problem]) => {
              const item = (snapshot.items ?? []).find((i) => i.id === itemId)
              return (
                <li key={itemId}>
                  第 {item?.seq ?? "?"} 题：{HEALTH_LABEL[problem] ?? problem}
                </li>
              )
            })}
            {health.size > 6 && <li>……还有 {health.size - 6} 道</li>}
          </ul>
          <p className="mt-1 text-xs">
            已入库的试卷不会因为题库改版而改变（它引用的是定稿时的版本），
            这里只是提醒你这几道题在题库里有更新。发起改版时会自动换成最新版本。
          </p>
        </div>
      )}

      <div className="rounded-xl border bg-white p-6 text-black sm:p-8">
        <PaperSheet snapshot={snapshot} mode="paper" />
      </div>
    </div>
  )
}
