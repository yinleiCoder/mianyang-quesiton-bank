// 试卷详情：只读整卷 + 状态 + 操作入口。
// 预览按**正卷**渲染（不含答案与解析）——答案走独立的打印路由，
// 免得学生在网页上直接看到答案。教师需要答案时点「打印答案」。
import Link from "next/link"
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperVersion, loadPaperHealth, HEALTH_LABEL, paperStatusChip } from "@/lib/paper-workbench"
import { loadSchools, loadSubjectNodes } from "@/lib/reference-data"
import { indexNodes } from "@/lib/subject-nodes"
import { loadPeople } from "@/lib/people"
import { fmtDate } from "@/lib/format"
import { round2 } from "@/lib/paper-units"
import { PaperSheet } from "@/components/papers/paper-sheet"
import { ExportPdfButton } from "@/components/papers/export-pdf-button"
import { PaperActions } from "@/components/papers/paper-actions"
import { PaperRevisionActions } from "@/components/papers/paper-revision-actions"
import { PaperInsightLinks } from "@/components/papers/paper-insight-links"
import { AccessDenied } from "@/components/access-denied"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PrinterIcon, FileCheckIcon, ArrowLeftIcon, AlertTriangleIcon, ClipboardCheckIcon, UsersIcon } from "lucide-react"

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

  // 学校名单先取（走缓存，命中时零往返），再把它传给 loadPeople ——
  // 否则 loadPeople 内部会为同样那几行再查一次（见 lib/people.js 文件头）。
  const schools = await loadSchools()
  const [snapshot, health, nodes, people] = await Promise.all([
    loadPaperVersion(supabase, versionId),
    loadPaperHealth(supabase, versionId),
    loadSubjectNodes(),
    loadPeople(supabase, [paper.creator_id], schools),
  ])
  const { pathOf } = indexNodes(nodes)
  const chip = paperStatusChip(snapshot.status)
  const isOwner = paper.creator_id === ctx.user?.id

  // 卷面题目的可用性分三类，别混成一句"题库有变化"：
  //   · 未入库：AI 一键成卷的草稿 / 在审版本 —— 要先去提交审核，刷新也刷不动；
  //   · 已下线/不存在：没有可替换的版本，只能从卷面移除；
  //   · 题库有新版本：已入库但旧版，点「刷新题目」即可。
  const items = snapshot.items ?? []
  const unavailable = items.filter((i) => {
    if (i.available !== false) return false
    // 已下线/已删除的走下面那条红色横幅，别在这里重复计数
    const problem = health.get(i.id)
    return problem !== "offline" && problem !== "missing"
  })
  const staleItems = items.filter((i) => i.available !== false && i.stale)
  const missingOrOffline = [...health.entries()].filter(([, p]) => p === "offline" || p === "missing")
  // 只要有一道不可用，提交就会被服务端拒（未入库/已下线都算）
  const blockedCount = items.filter((i) => i.available === false).length

  // 在流版本（草稿/审核中/退回）。详情页主预览默认是已入库版，改版草稿要单独给入口，
  // 否则发起改版之后这份草稿就"消失"了（2026-10-22 用户报）。
  const { data: inFlightVersions } = await supabase
    .from("paper_versions")
    .select("id, version_no, status")
    .eq("paper_id", id)
    .in("status", ["draft", "pending_group", "pending_city", "returned"])
    .order("version_no", { ascending: false })
  const inFlightVersion = inFlightVersions?.[0] ?? null
  const hasInFlight = (inFlightVersions ?? []).length > 0
  const hasWaitingApproval = (inFlightVersions ?? []).some(
    (v) => v.status === "pending_group" || v.status === "pending_city"
  )

  // 能不能删（决定「删除」出不出现）。判据与服务端 delete_paper 的断言同一条（0091）：
  // **有没有人考过** + 有没有在审任务。改版草稿/已退回本身不挡整卷删除（它没有在审任务）；
  // 真正拦人的仍是 RPC 里的断言与 exam_attempts 的 ON DELETE RESTRICT。
  const { count: attemptCount } = await supabase
    .from("exam_attempts")
    .select("id", { count: "exact", head: true })
    .eq("paper_id", id)
  const canDelete = isOwner && (attemptCount ?? 0) === 0 && !hasWaitingApproval

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
          {/* 成绩排行 / 试题分析：所有人可见（学生也要看自己的位置）；
              讲评模式只给教师（投屏用）。都只在已入库的卷子上出现 */}
          <PaperInsightLinks
            paperId={paper.id}
            published={snapshot.status === "published"}
            canLecture={ctx.isTeacher || ctx.isSchoolAdmin || ctx.isAdmin}
          />
          {/* 协作分派（0085）：只有创始人在草稿/退回状态下用得上 ——
              分派挂在在编辑的那一版上，且服务端那几个 RPC 也只认创始人。 */}
          {isOwner && (snapshot.status === "draft" || snapshot.status === "returned") && (
            <Button variant="outline" nativeButton={false} render={<Link href={`/papers/${paper.id}/assign`} />}>
              <UsersIcon className="size-4" /> 协作分派
            </Button>
          )}
          {/* 阅卷入口只给有权限的人（试卷作者/本校管理员/系统管理员）。
              真正的权限判断在 RPC 里，这里只是不给一个点了会被拒的入口 */}
          {snapshot.status === "published" && (isOwner || ctx.isSchoolAdmin || ctx.isAdmin) && (
            <Button variant="outline" nativeButton={false} render={<Link href={`/papers/${paper.id}/grading`} />}>
              <ClipboardCheckIcon className="size-4" /> 阅卷
            </Button>
          )}
          {/* 打印与下载配对相邻：同一件东西的两条出口（浏览器打印用系统字体，
              下载的是自己排版、内嵌字体的文件），别让人在两排按钮里找 */}
          <Button variant="outline" nativeButton={false} render={<a href={`/print/paper/${versionId}`} target="_blank" rel="noreferrer" />}>
            <PrinterIcon className="size-4" /> 打印正卷
          </Button>
          <ExportPdfButton snapshot={snapshot} mode="paper" hint="" />
          {ctx.isTeacher && (
            <Button variant="outline" nativeButton={false} render={<a href={`/print/paper/${versionId}/answers`} target="_blank" rel="noreferrer" />}>
              <FileCheckIcon className="size-4" /> 打印答案
            </Button>
          )}
          {ctx.isTeacher && <ExportPdfButton snapshot={snapshot} mode="answers" hint="" />}
        </div>
      </div>

      <PaperActions
        paperId={paper.id}
        versionId={versionId}
        status={snapshot.status}
        isOwner={isOwner}
        isTeacher={ctx.isTeacher}
        hasInFlight={hasInFlight}
        canDelete={canDelete}
        // 只有"已入库但旧版"的题能靠 paper_refresh_items 修；未入库/已下线的不行
        healthCount={staleItems.length}
        blockedCount={blockedCount}
      />

      {/* 已入库试卷的改版草稿：主预览仍是入库版，改版单独给编辑/删除入口。
          没有这条横幅时，发起改版后详情页看起来和改版前一样，草稿等于"消失"了。 */}
      {isOwner &&
        paper.current_published_version_id &&
        inFlightVersion &&
        inFlightVersion.id !== paper.current_published_version_id && (
          <div className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
            <p className="font-medium">
              有一份改版{paperStatusChip(inFlightVersion.status).text}（v{inFlightVersion.version_no}）
            </p>
            <p className="mt-1 text-xs">
              主预览仍是已入库版本。
              {inFlightVersion.status === "draft" || inFlightVersion.status === "returned"
                ? "改版可以继续编辑；不需要了可以只删这份草稿，已入库版本不受影响。"
                : "改版正在审核；如需修改请先撤回，撤回后回到草稿。"}
            </p>
            <div className="mt-2">
              <PaperRevisionActions versionId={inFlightVersion.id} status={inFlightVersion.status} />
            </div>
          </div>
        )}

      {isOwner && !canDelete && (
        <p className="text-xs text-muted-foreground">
          {attemptCount > 0
            ? `已有 ${attemptCount} 场考试记录，不能删除（学生还要在成绩单里看它）。`
            : hasWaitingApproval
              ? "有审核中的改版任务，不能删除整份试卷；请先在改版横幅里撤回。"
              : ""}
        </p>
      )}

      {unavailable.length > 0 && (
        <div className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangleIcon className="size-4" />
            有 {unavailable.length} 道题还没入库或版本已失效，这份试卷暂时不能提交
          </p>
          <p className="mt-1 text-xs">
            AI 一键成卷生成的是题目草稿；需要先在「我的题目」里提交审核，
            题目入库后回到这里点「刷新题目」再提交试卷。
          </p>
          {isOwner && (snapshot.status === "draft" || snapshot.status === "returned") && (
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href={`/papers/edit/${versionId}`} />}
            >
              去编辑器处理
            </Button>
          )}
        </div>
      )}

      {missingOrOffline.length > 0 && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangleIcon className="size-4" />
            有 {missingOrOffline.length} 道题已下线或已不存在
          </p>
          <ul className="mt-1 text-xs">
            {missingOrOffline.slice(0, 6).map(([itemId, problem]) => {
              const item = items.find((i) => i.id === itemId)
              return (
                <li key={itemId}>
                  第 {item?.seq ?? "?"} 题：{HEALTH_LABEL[problem] ?? problem}
                </li>
              )
            })}
            {missingOrOffline.length > 6 && <li>……还有 {missingOrOffline.length - 6} 道</li>}
          </ul>
          <p className="mt-1 text-xs">这些题没有可替换的入库版本，请先从卷面移除。</p>
        </div>
      )}

      {staleItems.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangleIcon className="size-4" />
            有 {staleItems.length} 道题在题库里有新版本
          </p>
          <p className="mt-1 text-xs">
            已入库的试卷不会因为题库改版而改变（它引用的是定稿时的版本）。
            草稿或被退回的试卷点「刷新题目」即可换到最新版本。
          </p>
        </div>
      )}

      <div className="rounded-xl border bg-white p-6 text-black sm:p-8">
        <PaperSheet snapshot={snapshot} mode="paper" />
      </div>
    </div>
  )
}
