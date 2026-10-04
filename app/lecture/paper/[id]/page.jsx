// 讲评模式：把一份卷子的成绩与逐题统计投到教室大屏上，一题一屏。
//
// **不进 (app) 路由组**（与 app/print/** 同一个理由）：那边有侧栏与页头，投影时会一起投出去。
// 仍然 requireUser()：草稿卷不该被任何人从这条路径看到。
//
// 一次取齐三样东西（一个 await，不拆 Suspense 边界）：
//   · 卷面快照（loadPaperVersion）——题面与选项，交给 QuestionView 渲染，与打印卷同源；
//   · 逐题统计（paper_question_stats，0078）——正确率、选项分布、错答名单；
//   · 成绩榜（paper_leaderboard，0077）——开场那一屏的分布与前三名。
// 三者的范围口径都由 0077 的 resolve_paper_scope 决定（教师恒可看）。
//
// `?i=` 与 `?reveal=` 只在这一层读一次（初值），之后由客户端改地址栏、不再打服务端
// ——见 lecture-deck.jsx 文件头的说明。
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperVersion } from "@/lib/paper-workbench"
import { loadPaperLeaderboard, loadPaperQuestionStats } from "@/lib/analytics"
import { loadMyClassOptions } from "@/lib/students"
import { LectureDeck } from "@/components/papers/lecture-deck"
import { AccessDenied } from "@/components/access-denied"

export const metadata = { title: "讲评模式" }

export default async function LecturePaperPage({ params, searchParams }) {
  const { id } = await params
  await requireUser()
  const ctx = await getAuthContext()
  if (!(ctx.isTeacher || ctx.isSchoolAdmin || ctx.isAdmin)) {
    return (
      <AccessDenied
        title="仅教师可用"
        description="讲评模式是投屏给全班看的，需要教师身份（学生请看自己的成绩单）。"
      />
    )
  }

  const sp = (await searchParams) ?? {}
  const initialIndex = Number.parseInt(sp.i ?? "0", 10)
  const initialReveal = sp.reveal === "1"
  let scope = ["class", "school", "city"].includes(sp.scope) ? sp.scope : "class"

  const supabase = await createClient()
  const { data: paper, error: paperError } = await supabase
    .from("papers")
    .select("id, current_published_version_id")
    .eq("id", id)
    .maybeSingle()
  if (paperError) throw paperError
  if (!paper?.current_published_version_id) {
    return (
      <AccessDenied
        title="这份试卷还没有入库"
        description="草稿与审核中的卷子没有成绩与统计可讲。"
      />
    )
  }

  // 班级口径要先定一个班（与讲评看板同款）。**一个班都没有时退到全校** ——
  // 系统管理员、市级专家本人不带班，而讲评是投屏给一屋子人看的，
  // 不能因为"你没有班"就整页 500（原先就是这样：scope='class' 且 class_id 为空，
  // 服务端 resolve_paper_scope 抛 22023）。真正用的范围会显示在开场那一行的
  // 范围标签里（LectureDeck 渲染 board.scope.label），不会悄悄换口径。
  let classId = null
  if (scope === "class") {
    const { classes } = await loadMyClassOptions(supabase)
    classId = classes?.[0]?.class_id ?? null
    if (!classId) scope = "school"
  }

  const [snapshot, statsRes, boardRes] = await Promise.all([
    loadPaperVersion(supabase, paper.current_published_version_id),
    loadPaperQuestionStats(supabase, { paperId: id, scope, classId }),
    loadPaperLeaderboard(supabase, { paperId: id, scope, classId }),
  ])
  if (statsRes.denied || boardRes.denied) {
    return <AccessDenied title="不能讲评这份卷子" description="试题分析只有教师及以上可看。" />
  }
  // needClass 上面已经处理掉了，真漏过来也只是"没有统计"（各题的统计为 null），
  // 不该把整页打成错误页 —— 与讲评看板同一条：error 且非 needClass 才抛
  if (statsRes.error && !statsRes.needClass) throw statsRes.error
  if (boardRes.error && !boardRes.needClass) throw boardRes.error

  // 题面（快照）与统计（RPC）按 paper_item.id 对齐——两边的 item_id 都是 paper_items.id。
  const statByItem = new Map((statsRes.stats?.items ?? []).map((s) => [s.item_id, s]))
  const slides = (snapshot.items ?? []).map((item) => ({
    itemId: item.id,
    seq: item.seq,
    qtype: item.qtype,
    score: item.score,
    content: item.content,
    stat: statByItem.get(item.id) ?? null,
  }))

  return (
    <LectureDeck
      paper={{
        id: snapshot.id ?? id,
        versionId: paper.current_published_version_id,
        title: snapshot.title ?? "试卷",
        fullScore: Number(snapshot.total_score) || 0,
      }}
      slides={slides}
      board={boardRes.board}
      initialIndex={Number.isFinite(initialIndex) ? initialIndex : 0}
      initialReveal={initialReveal}
    />
  )
}
