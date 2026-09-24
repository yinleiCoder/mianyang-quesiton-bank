// 试卷的成绩与试题分析：两个页签（成绩排行 / 试题分析）× 三档范围（全班/全校/全市）。
//
// 数据来自两个 SECURITY DEFINER 的 RPC（0077 / 0078），各自**一次取齐**整页所需的全部内容
// （与 /students/[id] 同一条做法：一个 RPC = 一个 await，不拆多个 Suspense 边界）。
//
// 三处口径必须在页面上说清楚，否则会被当成 bug：
//   · 只统计**官方成绩**——同一份卷面只有第一次交卷计入，重做是自主练习；
//   · 排行榜只收**已出分**的；**试题分析收已交卷的**（含待阅卷）——客观题交卷即定稿，
//     而讲评往往在最后一题判完之前就要开；
//   · 两者都只看**当前入库版本**，旧版场次单独计数。
//
// 试题分析还有一条硬门禁（0078）：**学生必须自己已经出分**才能看——
// 选项分布 + 标准答案合起来就是答案本身。教师不受此限。
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadMyClassOptions } from "@/lib/students"
import {
  loadPaperLeaderboard,
  loadPaperQuestionStats,
  parseAnalyticsFilters,
  percentText,
} from "@/lib/analytics"
import { BoardTabs } from "@/components/analytics/board-tabs"
import { ScopeTabs } from "@/components/analytics/scope-tabs"
import { LeaderboardTable } from "@/components/analytics/leaderboard-table"
import { MyRankCard } from "@/components/analytics/my-rank-card"
import { QuestionStatsList } from "@/components/analytics/question-stats-list"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"

export async function generateMetadata({ params }) {
  const { id } = await params
  return { title: `成绩与分析 ${id.slice(0, 8)}` }
}

export default async function PaperBoardPage({ params, searchParams }) {
  const { id } = await params
  await requireUser()
  const ctx = await getAuthContext()
  const supabase = await createClient()

  const sp = (await searchParams) ?? {}
  const filters = parseAnalyticsFilters(sp)
  const { tab, scope } = filters

  const { data: paper, error: paperError } = await supabase
    .from("papers")
    .select("id, state, current_published_version_id")
    .eq("id", id)
    .maybeSingle()
  if (paperError) throw paperError
  if (!paper) {
    return <AccessDenied title="试卷不存在" description="它可能已被删除，或链接有误。" />
  }
  if (!paper.current_published_version_id) {
    return (
      <AccessDenied
        title="这份试卷还没有入库"
        description="草稿与审核中的卷子没有成绩可言：入库后学生才能考，考完才有数据。"
      />
    )
  }

  // 教师看班级口径要先选班：班级下拉复用 list_my_student_classes（权限口径与 RPC 一致）
  const isStaff = Boolean(ctx.isAdmin || ctx.isSchoolAdmin || ctx.isTeacher)
  let classes = []
  if (isStaff && scope === "class") {
    const { classes: list } = await loadMyClassOptions(supabase)
    classes = list ?? []
  }
  const activeClassId = filters.classId || classes[0]?.class_id || null

  const shared = {
    paperId: id,
    tab,
    scope,
    classId: filters.classId,
    classes,
    activeClassId,
  }

  // ---------- 试题分析 ----------
  if (tab === "questions") {
    const { stats, needClass, denied, error } = await loadPaperQuestionStats(supabase, {
      paperId: id,
      scope,
      classId: activeClassId,
    })
    if (denied) {
      return (
        <AccessDenied
          title={isStaff ? "不能查看这个班级的分析" : "出分后才能看试题分析"}
          description={
            isStaff
              ? "只有本校、且专业覆盖这个班的教师（或管理员）能看。"
              : "这份分析包含标准答案与选项分布，你这场卷子判完出分后就能看了。"
          }
        />
      )
    }
    if (error && !needClass) throw error

    const info = stats?.paper ?? {}
    const counts = stats?.stats ?? {}
    return (
      <div className="space-y-4">
        <PageHeader
          title={`试题分析 · ${info.title || "试卷"}`}
          description={
            <>
              本次考试 <b className="tabular-nums">{counts.attempts ?? 0}</b> 人参与
              {Number(counts.ungraded) > 0 && ` · 其中 ${counts.ungraded} 人待阅卷`}
              {Number(counts.other_version_skipped) > 0 &&
                ` · 另有 ${counts.other_version_skipped} 场考的是旧版卷面，未计入`}
            </>
          }
        />
        <BoardTabs {...shared} />
        {needClass ? (
          <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
            你还看不到任何班级（教师需要学校管理员先分配专业与班级）。先切到「全校」或「全市」。
          </p>
        ) : (
          <>
            <ScopeTabs {...shared} />
            <QuestionStatsList items={stats?.items ?? []} studentLimit={stats?.student_limit ?? 50} />
          </>
        )}
      </div>
    )
  }

  // ---------- 成绩排行 ----------
  const { board, needClass, denied, error } = await loadPaperLeaderboard(supabase, {
    paperId: id,
    scope,
    classId: activeClassId,
  })
  if (denied) {
    return (
      <AccessDenied
        title="不能查看这个班级的榜单"
        description="只有本校、且专业覆盖这个班的教师（或管理员）能看。"
      />
    )
  }
  if (error) throw error

  const stats = board?.stats ?? {}
  const paperInfo = board?.paper ?? {}

  return (
    <div className="space-y-4">
      <PageHeader
        title={`成绩排行 · ${paperInfo.title || "试卷"}`}
        description={
          <>
            满分 {Number(paperInfo.full_score) || 0} 分
            {paperInfo.exam_name ? ` · ${paperInfo.exam_name}` : ""}
            <span className="mx-2 text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              只有<b className="font-medium text-foreground">第一次</b>交卷计入排行（重做算自主练习），
              主观题判完出分后才进榜。
            </span>
          </>
        }
      />
      <BoardTabs {...shared} />

      {needClass ? (
        <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
          你还看不到任何班级（教师需要学校管理员先分配专业与班级）。先切到「全校」或「全市」。
        </p>
      ) : (
        <>
          <ScopeTabs {...shared} />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-muted/30 px-4 py-3 text-sm">
            <span>
              上榜 <b className="tabular-nums">{stats.total ?? 0}</b> 人
            </span>
            {stats.avg_score != null && (
              <span className="text-muted-foreground">
                平均 <b className="text-foreground tabular-nums">{Number(stats.avg_score)}</b> 分
                （{percentText(stats.avg_percent)}）
              </span>
            )}
            {stats.max_score != null && (
              <span className="text-muted-foreground tabular-nums">
                最高 {Number(stats.max_score)} · 最低 {Number(stats.min_score)}
              </span>
            )}
            {Number(stats.ungraded) > 0 && (
              <span className="text-amber-600">还有 {stats.ungraded} 人待阅卷，出分后才进榜</span>
            )}
            {Number(stats.other_version_skipped) > 0 && (
              <span className="text-muted-foreground">
                另有 {stats.other_version_skipped} 场考的是旧版卷面，未计入本榜
              </span>
            )}
          </div>

          <MyRankCard board={board} viewerNote={board?.viewer_note} />
          <LeaderboardTable board={board} />
        </>
      )}
    </div>
  )
}
