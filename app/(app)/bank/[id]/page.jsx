// 题库详情：全市共享题目只读页。仅在线（live）且已入库的当前版本可看；
// 草稿/审核中/已下线一律不可见（与服务端查询口径一致）。答案解析默认展开，可随时收起。
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { indexNodes } from "@/lib/subject-nodes"
import { loadSchools, loadSubjectNodes, schoolNameOf } from "@/lib/reference-data"
import { fmtDate } from "@/lib/format"
import { loadPeople } from "@/lib/people"
import { buildAccuracyMap, errorRatePercent, HIGH_ERROR_RATE } from "@/lib/accuracy"
import {
  loadQuestionReports,
  loadMyQuestionReport,
  reportCategoryLabel,
  reportStateChip,
} from "@/lib/question-reports"
import { QuestionReader } from "@/components/bank/question-reader"
import { PersonChip } from "@/components/bank/person-chip"
import { QuestionReportButton } from "@/components/bank/question-report-button"
import { AccessDenied } from "@/components/access-denied"
import { Badge } from "@/components/ui/badge"
import { ArrowLeftIcon, PrinterIcon, SparklesIcon } from "lucide-react"

export const metadata = { title: "题目详情" }

export default async function BankQuestionPage({ params }) {
  const { id } = await params
  const ctx = await requireUser()
  const supabase = await createClient()

  const { data: q, error: qError } = await supabase
    .from("questions")
    .select("id, school_id, course_node_id, creator_id, state, current_published_version_id")
    .eq("id", id)
    .maybeSingle()
  // 查询失败与「题目不可见」是两回事：前者抛出交给错误边界，后者才是可见性提示
  if (qError) throw qError
  if (!q || q.state !== "live" || !q.current_published_version_id) {
    return (
      <AccessDenied
        title="题目不可见"
        description="这道题可能尚未入库、正在审核中，或已被下线。已入库题目仅在下线审批前对全市教师可见。"
      />
    )
  }

  // 学校名单走缓存的参考数据（全市共 9 行、与调用者无关），不在这里单独查 ——
  // 详情页本来就只有 1 行数据要装配，为它在并发波里多占一格连接不划算。
  const [vRes, nodes, schools, tagRes, apprRes, accuracyRes, myReportRes] = await Promise.all([
    supabase
      .from("question_versions")
      .select("id, version_no, change_type, qtype, difficulty, content, published_at, created_by")
      .eq("id", q.current_published_version_id)
      .single(),
    loadSubjectNodes(),
    loadSchools(),
    supabase.from("version_tags").select("tag_name").eq("version_id", q.current_published_version_id),
    supabase.rpc("bank_reviewers", { p_version_ids: [q.current_published_version_id] }),
    // 全站作答统计（按题目聚合，跨版本累计）。无人作答时该题不会出现在结果里 → accuracy 为 undefined。
    supabase.rpc("question_accuracy", { p_question_ids: [q.id] }),
    // 我自己在这道题上提过的反馈（RLS 只放行自己的行）。
    // 作者处理时写的那句说明会在这里显示出来 —— 这是本功能与通用意见反馈最大的不同：
    // 反馈有回复闭环，学生能看到回音。
    loadMyQuestionReport(supabase, q.id),
  ])
  for (const r of [vRes, tagRes, apprRes, accuracyRes]) if (r.error) throw r.error
  const accuracy = buildAccuracyMap(accuracyRes.data).get(q.id)
  const v = vRes.data
  const { pathOf: nodePath } = indexNodes(nodes)
  const tags = (tagRes.data ?? []).map((t) => t.tag_name)
  const schoolName = schoolNameOf(schools, q.school_id) ?? ""

  // 作者 + 两级审核通过人（决定人已注销的审批行 decided_by 已置空 → 不计入）
  const approvedBy = (apprRes.data ?? []).filter((a) => a.decided_by)
  const peopleMap = await loadPeople(
    supabase,
    [v.created_by, ...approvedBy.map((a) => a.decided_by)],
    schools
  )
  const author = v.created_by ? peopleMap.get(v.created_by) ?? null : null
  const reviewers = approvedBy
    .map((a) => ({ caption: a.stage === "group" ? "组长" : "专家", person: peopleMap.get(a.decided_by) }))
    .filter((r) => r.person)
  const authorEverExisted = Boolean(q.creator_id || v.created_by)

  const isOwner = ctx.user.id === q.creator_id
  const myReport = myReportRes ?? null

  // 「本题反馈」面板只对能处理的人渲染（作者 / 学校管理员 / 系统管理员）。
  // **权限判定不在前端复刻** —— 服务端 can_handle_question_report 已经有一份，
  // 复刻一份迟早漂移（改了 SQL 忘了改 JS，面板就会对无权的人显示出来）。
  // 这里照调，权限不够时 RPC 抛 42501，直接按"没有面板"处理。
  let reports = []
  try {
    reports = await loadQuestionReports(supabase, q.id)
  } catch (err) {
    if (err?.code !== "42501") throw err
  }
  const openReportCount = reports.filter((r) => r.status === "open").length

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/bank"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" /> 返回题库
        </Link>
        <div className="flex items-center gap-4">
          {/* 纠错入口。作者本人看自己的题时不给这个按钮 —— 自己给自己提反馈没有意义，
              要改直接走改版。 */}
          {!isOwner && (
            <QuestionReportButton
              questionId={q.id}
              versionId={v.id}
              versionNo={v.version_no}
            />
          )}
          {/* 打印页是独立路由（没有侧栏/页头），新标签打开——当前页仍留着继续看 */}
          <Link
            href={`/print/question/${q.id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <PrinterIcon className="size-4" /> 打印这道题
          </Link>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <Badge className="px-2 py-0.5 text-xs">{qtypeLabel(v.qtype)}</Badge>
          <span className="text-sm text-muted-foreground">难度 {difficultyLabel(v.difficulty)}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">v{v.version_no}</span>
          {/* 全站作答错误率。无作答记录时整段不渲染 —— 详情页留白比摆一个可能是 0% 的占位干净。
              口径是"客观题的全站累计"（question_accuracy 只统计 grading='auto'），跨版本累计。 */}
          {accuracy && (
            <span
              className={
                "text-sm " +
                (accuracy.errorRate >= HIGH_ERROR_RATE
                  ? "font-medium text-rose-700 dark:text-rose-400"
                  : "text-muted-foreground")
              }
              title={`全站共 ${accuracy.attempts} 次作答，答对 ${accuracy.correct} 次（不含主观自评题）`}
            >
              错误率 {errorRatePercent(accuracy)}
              <span className="ml-1 text-xs text-muted-foreground/70">({accuracy.attempts} 次作答)</span>
            </span>
          )}
          {v.change_type === "edit" && (
            <span className="text-xs text-muted-foreground">改版后的最新入库版本</span>
          )}
          <span className="ml-auto text-xs text-muted-foreground">入库于 {fmtDate(v.published_at)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
          <span>{nodePath(q.course_node_id) || "未选节点"}</span>
          {schoolName && <span>题源：{schoolName}</span>}
          {authorEverExisted && <PersonChip person={author} caption="作者" />}
          {reviewers.map((r) => (
            <PersonChip key={r.caption} person={r.person} caption={r.caption} />
          ))}
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t, i) => (
              <Badge key={i} variant="secondary">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-card p-4 sm:p-6">
        <QuestionReader qtype={v.qtype} content={v.content} />
      </div>

      {/* 我自己提过的反馈：把作者的回复亮出来。
          这是本功能与通用意见反馈最大的不同 —— 那边是"不在这里回复"，
          这边有闭环。不显示回音的话，学生的观感和石沉大海没区别。 */}
      {myReport && (
        <div className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">我的反馈</span>
            <span
              className={`rounded px-1.5 py-0.5 text-xs ${reportStateChip(myReport.status).cls}`}
            >
              {reportStateChip(myReport.status).text}
            </span>
            <span className="text-xs text-muted-foreground">
              {reportCategoryLabel(myReport.category)} · {fmtDate(myReport.created_at)}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{myReport.content}</p>
          {myReport.status === "resolved" ? (
            <p className="mt-2 border-t pt-2 text-sm">
              <span className="text-muted-foreground">作者回复：</span>
              {myReport.resolve_note}
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              作者还没处理。处理后会在这里回复你。
            </p>
          )}
        </div>
      )}

      {/* 作者/学校管理员视角：这道题收到的全部反馈。
         处理动作在收件箱里做（/questions/reports），这里只做呈示 + 入口 ——
          一行反馈点进去还要选"改版"还是"确认无误"，塞在这块里会把题目页撑得很长。 */}
      {reports.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">本题反馈</span>
            {openReportCount > 0 && (
              <Badge variant="destructive" className="text-xs">
                {openReportCount} 条待处理
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">共 {reports.length} 条</span>
            <Link
              href="/questions/reports"
              className="ml-auto text-sm underline underline-offset-2 hover:text-foreground"
            >
              去收件箱处理
            </Link>
          </div>
          <ul className="mt-3 space-y-3">
            {reports.slice(0, 5).map((r) => (
              <li key={r.id} className="border-t pt-3 text-sm first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${reportStateChip(r.status).cls}`}
                  >
                    {reportStateChip(r.status).text}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {reportCategoryLabel(r.category)}
                  </span>
                  {/* 版本号必须露出来：学生提的是 v3 的问题，而当前可能已经是 v4 了。
                      不标出来，作者会拿旧版本的描述去对照新版本的内容，越看越糊涂。 */}
                  <span
                    className={
                      "rounded px-1.5 py-0.5 text-xs " +
                      (r.is_current_version
                        ? "bg-muted text-muted-foreground"
                        : "bg-amber-100 text-amber-700")
                    }
                  >
                    v{r.version_no}
                    {r.is_current_version ? "（当前版本）" : "（已被改版）"}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {fmtDate(r.created_at)}
                  </span>
                </div>
                <p className="mt-1.5 text-muted-foreground">{r.content}</p>
                <p className="mt-1 text-xs text-muted-foreground/80">
                  来自 {r.reporter?.name ?? "账号已注销"}
                </p>
              </li>
            ))}
          </ul>
          {reports.length > 5 && (
            <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
              还有 {reports.length - 5} 条，去收件箱看全部。
            </p>
          )}
        </div>
      )}

      <p className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground/80">
        <SparklesIcon className="size-3.5 shrink-0" />
        本题为全市共享题目，内容经两级审核入库后不可修改；
        {isOwner
          ? "发现错误可在「我的题目」里发起改版，"
          : "发现错误可点上方「这题有问题」反馈给作者，作者核对后会在这道题下面回复你，"}
        新版本经审批后自动替换在线内容。
        {isOwner && (
          <Link href="/questions" className="underline underline-offset-2 hover:text-foreground">
            在我的题目中管理这道题
          </Link>
        )}
      </p>
    </div>
  )
}
