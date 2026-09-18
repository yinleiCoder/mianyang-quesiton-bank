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
import { QuestionReader } from "@/components/bank/question-reader"
import { PersonChip } from "@/components/bank/person-chip"
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
  const [vRes, nodes, schools, tagRes, apprRes, accuracyRes] = await Promise.all([
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

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/bank"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" /> 返回题库
        </Link>
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

      <p className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground/80">
        <SparklesIcon className="size-3.5 shrink-0" />
        本题为全市共享题目，内容经两级审核入库后不可修改；发现错误可由出题学校发起改版，新版本经审批后自动替换在线内容。
        {isOwner && (
          <Link href="/questions" className="underline underline-offset-2 hover:text-foreground">
            在我的题目中管理这道题
          </Link>
        )}
      </p>
    </div>
  )
}
