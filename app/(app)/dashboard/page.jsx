// 工作台：全市数据概览 + 个人待办 + 最近入库。按角色叠加区块：
// 教师看 全市题库/我的题目/待我审核（有任命时）/最近入库；系统管理员与学校管理员叠加管理入口。
import Link from "next/link"
import { getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadMyQuestions, WORKBENCH_FILTERS } from "@/lib/question-workbench"
import { contentSummary, qtypeLabel, qtypeShortLabel } from "@/lib/question-model"
import { fmtDate } from "@/lib/format"
import { SchoolContributionChart } from "@/components/dashboard/school-contribution-chart"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Building2Icon,
  ChevronRightIcon,
  FileTextIcon,
  GitBranchIcon,
  GraduationCapIcon,
  InboxIcon,
  LibraryBigIcon,
  PlusIcon,
  TagsIcon,
  UsersIcon,
} from "lucide-react"

export const metadata = { title: "工作台" }

function StatCard({ href, icon: Icon, label, value, sub, tone = "default" }) {
  const body = (
    <Card className="h-full transition-colors hover:border-primary/50">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pb-4">
        <p className={`text-3xl font-semibold tracking-tight ${tone === "primary" ? "text-primary" : ""}`}>
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  )
  if (!href) return body
  return (
    <Link href={href} className="block">
      {body}
    </Link>
  )
}

function CardLink({ href, children }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between rounded-lg border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent"
    >
      {children}
      <ChevronRightIcon className="size-4 text-muted-foreground" />
    </Link>
  )
}

export default async function DashboardPage() {
  const ctx = await getAuthContext()
  const profile = ctx.profile
  const supabase = await createClient()
  const uid = ctx.user?.id ?? ""

  // ---------- 数据 ----------
  const [bankRes, myRes, waitingRes, recentRes, contribRes] = await Promise.all([
    // 全市已入库（live + 当前 published 指针，与 /bank 口径一致）
    supabase
      .from("question_versions")
      .select("id, question:questions!question_versions_question_id_fkey!inner(id)", { count: "exact", head: true })
      .eq("status", "published")
      .eq("question.state", "live"),
    uid ? loadMyQuestions(supabase, uid) : Promise.resolve({ rows: [] }),
    // 待我审核（有生效任命即返回；无任命时 count=0 不影响展示）
    supabase.from("approvals").select("id", { count: "exact", head: true }).eq("state", "waiting").eq("assigned_user_id", uid),
    supabase
      .from("question_versions")
      .select(
        "id, question_id, version_no, qtype, content, published_at, created_by, question:questions!question_versions_question_id_fkey!inner(id, school_id, creator_id, state)"
      )
      .eq("status", "published")
      .eq("question.state", "live")
      .order("published_at", { ascending: false })
      .limit(5),
    // 学校贡献（全体登录用户可见）：各校教师数 + 题目数
    supabase.rpc("school_contribution_stats"),
  ])
  // 统计卡与最近入库的数据必须查得到，否则数字会静默显示成 0（错误由 (app)/error.jsx 兜底）
  for (const r of [bankRes, waitingRes, recentRes]) if (r.error) throw r.error
  // 学校贡献图表为可选区块：查询失败时隐藏卡片即可（学校贡献 RPC 未部署/无权限）
  const schoolStats = contribRes?.error ? null : (contribRes?.data ?? [])
  const myRows = myRes.rows ?? []
  const bankCount = bankRes.count ?? 0
  const myWaiting = waitingRes.count ?? 0
  // 各状态计数：直接复用 /questions 筛选页签的谓词，两处口径永远一致
  //（displayState 的取值是 pending_group/pending_city/published，不能按原样当键）
  const stat = Object.fromEntries(
    WORKBENCH_FILTERS.map((f) => [f.key, myRows.filter((r) => f.match(r.displayState)).length])
  )

  // 最近入库的行外字典：学校名 + 作者姓名（school_id 在 questions 上，作者取 created_by）
  const recent = recentRes.data ?? []
  const schoolIds = [...new Set(recent.map((v) => v.question?.school_id).filter(Boolean))]
  const creatorIds = [...new Set(recent.map((v) => v.created_by).filter(Boolean))]
  const [schoolRes, profileRes] = await Promise.all([
    schoolIds.length ? supabase.from("schools").select("id, name").in("id", schoolIds) : Promise.resolve({ data: [] }),
    creatorIds.length
      ? supabase.from("profiles").select("user_id, name").in("user_id", creatorIds)
      : Promise.resolve({ data: [] }),
  ])
  const schoolMap = new Map((schoolRes.data ?? []).map((s) => [s.id, s.name]))
  const creatorMap = new Map((profileRes.data ?? []).map((p) => [p.user_id, p.name]))

  // ---------- 平台规模（仅系统管理员展示） ----------
  let adminStats = null
  if (ctx.isAdmin) {
    const [schoolsC, usersC, nodesC, tagsC, unassignedC] = await Promise.all([
      supabase.from("schools").select("id", { count: "exact", head: true }),
      supabase.from("profiles").select("user_id", { count: "exact", head: true }),
      supabase.from("subject_nodes").select("id", { count: "exact", head: true }),
      supabase.from("tags").select("id", { count: "exact", head: true }),
      supabase.from("approvals").select("id", { count: "exact", head: true }).eq("state", "waiting").is("assigned_user_id", null),
    ])
    adminStats = {
      schools: schoolsC.count ?? 0,
      users: usersC.count ?? 0,
      nodes: nodesC.count ?? 0,
      tags: tagsC.count ?? 0,
      unassigned: unassignedC.count ?? 0,
    }
  }

  const myInflight = myRows
    .filter((r) => WORKBENCH_FILTERS.find((f) => f.key === "pending").match(r.displayState))
    .slice(0, 3)

  // 我的题目卡片副标题：各状态计数（只列非零项）
  const myCountText = WORKBENCH_FILTERS.filter((f) => f.key !== "all" && stat[f.key] > 0)
    .map((f) => `${f.label} ${stat[f.key]}`)
    .join(" · ")

  return (
    <div className="space-y-6">
      <PageHeader
        title={`你好，${profile?.name ?? "老师"} 👋`}
        description="全市共建共享题库：你的题目经两级审核入库后，与各校共享。"
      />

      {/* 教师身份待审核提示（0025：审核通过后才获得出题/审批权限） */}
      {ctx.isPendingTeacher && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <GraduationCapIcon className="mt-0.5 size-4 shrink-0" />
          <span>教师身份审核中，暂以学生身份使用（可浏览题库）；审核通过后即可出题与参与审批。</span>
        </div>
      )}

      {/* ---------- 统计卡 ---------- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          href="/bank"
          icon={LibraryBigIcon}
          label="全市题库"
          value={bankCount}
          sub="已入库、全市可见的题目总数"
          tone="primary"
        />
        <StatCard
          href="/questions"
          icon={FileTextIcon}
          label="我的题目"
          value={myRows.length}
          sub={myRows.length ? myCountText : "去出第一题"}
        />
        <StatCard
          href={ctx.isApprover ? "/review" : undefined}
          icon={InboxIcon}
          label="待我审核"
          value={myWaiting}
          sub={ctx.isApprover ? "审批收件箱中的等待任务" : "被任命为组长/专家后此处可见"}
        />
        {ctx.isAdmin ? (
          <StatCard
            href="/bank"
            icon={GraduationCapIcon}
            label="平台规模"
            value={`${adminStats.schools} 校 / ${adminStats.users} 人`}
            sub={`${adminStats.nodes} 个科目节点 · ${adminStats.tags} 个标签 · ${adminStats.unassigned} 个待指派任务`}
          />
        ) : ctx.isTeacher ? (
          <StatCard
            href="/questions/new"
            icon={PlusIcon}
            label="快速出题"
            value="出题"
            sub={profile?.school_id ? "为共建题库贡献一道新题" : "绑定学校后即可出题"}
          />
        ) : (
          <StatCard
            href="/bank"
            icon={LibraryBigIcon}
            label="去刷题"
            value="题库"
            sub="浏览已入库题目，在移动端随时刷题练习"
          />
        )}
      </div>

      {/* ---------- 学校贡献图表（全体登录用户） ---------- */}
      {schoolStats && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">学校贡献</CardTitle>
              <span className="text-xs text-muted-foreground">
                {schoolStats.length} 所启用学校 · 教师{" "}
                {schoolStats.reduce((a, s) => a + Number(s.teacher_count), 0)} 人 · 题目{" "}
                {schoolStats.reduce((a, s) => a + Number(s.question_count), 0)} 道
              </span>
            </div>
            <CardDescription>各校教师数与贡献题目数（含下线题），全市共建共享进度</CardDescription>
          </CardHeader>
          <CardContent>
            <SchoolContributionChart data={schoolStats} />
          </CardContent>
        </Card>
      )}

      {/* ---------- 管理入口（管理角色） ---------- */}
      {(ctx.isAdmin || ctx.isSchoolAdmin) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">管理台入口</CardTitle>
            <CardDescription>{ctx.isAdmin ? "系统管理员" : "学校管理员"}：任务分配与基础数据维护</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ctx.isAdmin && (
              <>
                <CardLink href="/admin/schools">
                  <span className="flex items-center gap-2">
                    <Building2Icon className="size-4" /> 学校管理
                  </span>
                </CardLink>
                <CardLink href="/admin/tree">
                  <span className="flex items-center gap-2">
                    <GitBranchIcon className="size-4" /> 科目树维护
                  </span>
                </CardLink>
                <CardLink href="/admin/users">
                  <span className="flex items-center gap-2">
                    <UsersIcon className="size-4" /> 用户与任命
                  </span>
                </CardLink>
                <CardLink href="/admin/tags">
                  <span className="flex items-center gap-2">
                    <TagsIcon className="size-4" /> 标签管理
                  </span>
                </CardLink>
              </>
            )}
            {!ctx.isAdmin && ctx.isSchoolAdmin && (
              <CardLink href="/admin/users">
                <span className="flex items-center gap-2">
                  <UsersIcon className="size-4" /> 本校用户与任命
                </span>
              </CardLink>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------- 最近入库 ---------- */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">最近入库</CardTitle>
              <Link href="/bank" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                去题库浏览
              </Link>
            </div>
            <CardDescription>全市最近通过审核的题目（改版入库后仅保留最新版本）</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {recent.length === 0 ? (
              <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                还没有已入库题目
              </p>
            ) : (
              recent.map((v) => (
                <Link
                  key={v.id}
                  href={`/bank/${v.question_id}`}
                  className="flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors hover:border-primary/50 hover:bg-accent/30"
                >
                  {/* min-w（而非定宽 w）：简称都放得下，列仍对齐；将来出现更长的题型名也只是把题干推右，不会压上去 */}
                  <span className="min-w-14 shrink-0">
                    <Badge variant="outline" className="px-1.5 py-0 text-xs" title={qtypeLabel(v.qtype)}>
                      {qtypeShortLabel(v.qtype)}
                    </Badge>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{contentSummary(v.content)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {schoolMap.get(v.question?.school_id) ?? ""}
                    {creatorMap.get(v.created_by) ? ` · ${creatorMap.get(v.created_by)}` : " · 已注销"} · {fmtDate(v.published_at)}
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        {/* ---------- 我的进行中 ---------- */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">我的进行中</CardTitle>
              <Link href="/questions" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                全部题目
              </Link>
            </div>
            <CardDescription>
              审核中的提交可撤回；被退回的按意见修改后重新提交即全链重审。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {myInflight.length === 0 ? (
              <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                当前没有审核中的题目
              </p>
            ) : (
              myInflight.map((r) => {
                const chip = r.displayState === "pending_group" ? "组长审核中" : "专家审核中"
                return (
                  <Link
                    key={r.question.id}
                    href="/questions"
                    className="flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors hover:border-primary/50 hover:bg-accent/30"
                  >
                    <Badge className={`shrink-0 ${r.displayState === "pending_group" ? "bg-amber-100 text-amber-700" : "bg-orange-100 text-orange-700"}`}>
                      {chip}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-sm">{r.summary || "（题干为空）"}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">v{r.shownVersion?.version_no ?? ""}</span>
                  </Link>
                )
              })
            )}
            {stat.returned > 0 && (
              <Link href="/questions?status=returned" className="text-xs text-rose-600 underline-offset-2 hover:underline">
                还有 {stat.returned} 道被退回的题目等待按意见修改 →
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
