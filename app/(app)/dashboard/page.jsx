// 工作台：全市数据概览 + 个人待办 + 最近入库。按角色叠加区块：
// 教师看 全市题库/我的题目/待我审核（有任命时）/最近入库；系统管理员与学校管理员叠加管理入口。
//
// 流式渲染：原先这里串了三波 Promise.all（5 并行 → 2 并行 → 管理端 5 并行），
// 最慢的一波里还套着 loadMyQuestions 的 3 次串行往返 —— 整页要等 1.2–1.5s 才有第一字节，
// 期间用户看到的是白屏。现在每个区块自带 <Suspense>：标题与卡片骨架立刻出，
// 各区块的数据各自到、各自填（见 docs/加速落地手册.md）。
import { Suspense } from "react"
import Link from "next/link"
import { getAuthContext } from "@/lib/auth"
import { WORKBENCH_FILTERS } from "@/lib/question-workbench"
import { contentSummary, qtypeLabel, qtypeShortLabel } from "@/lib/question-model"
import { fmtDate } from "@/lib/format"
import {
  countByFilter,
  getAdminStats,
  getBankCount,
  getMyRows,
  getMyWaiting,
  getRecent,
  getSchoolStats,
} from "./_data"
import { SchoolContributionChart } from "@/components/dashboard/school-contribution-chart-lazy"
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

// 骨架与 StatCard 同结构同高，避免数字到位时整行跳动
function StatCardSkeleton() {
  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent className="space-y-2 pb-4">
        <div className="h-8 w-20 animate-pulse rounded bg-muted" />
        <div className="h-3 w-32 animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  )
}

function SectionSkeleton({ lines = 3 }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        <div className="h-3 w-48 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />
        ))}
      </CardContent>
    </Card>
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

// 数据层（6 个 cache() loader + countByFilter）全部搬到了 ./_data.js：
// 本文件只负责 UI 结构与 <Suspense> 边界，读代码时不必在数据查询里翻找组件。

// ---------- 各区块 ----------

async function BankCountCard() {
  const count = await getBankCount()
  return (
    <StatCard
      href="/bank"
      icon={LibraryBigIcon}
      label="全市题库"
      value={count}
      sub="已入库、全市可见的题目总数"
      tone="primary"
    />
  )
}

async function MyQuestionsCard() {
  const rows = await getMyRows()
  const stat = countByFilter(rows)
  // 副标题：各状态计数（只列非零项）
  const countText = WORKBENCH_FILTERS.filter((f) => f.key !== "all" && stat[f.key] > 0)
    .map((f) => `${f.label} ${stat[f.key]}`)
    .join(" · ")
  return (
    <StatCard
      href="/questions"
      icon={FileTextIcon}
      label="我的题目"
      value={rows.length}
      sub={rows.length ? countText : "去出第一题"}
    />
  )
}

async function WaitingCard({ isApprover }) {
  const myWaiting = await getMyWaiting()
  return (
    <StatCard
      href={isApprover ? "/review" : undefined}
      icon={InboxIcon}
      label="待我审核"
      value={myWaiting}
      sub={isApprover ? "审批收件箱中的等待任务" : "被任命为组长/专家后此处可见"}
    />
  )
}

async function AdminScaleCard() {
  const s = await getAdminStats()
  return (
    <StatCard
      href="/bank"
      icon={GraduationCapIcon}
      label="平台规模"
      value={`${s.schools} 校 / ${s.users} 人`}
      sub={`${s.nodes} 个科目节点 · ${s.tags} 个标签 · ${s.unassigned} 个待指派任务`}
    />
  )
}

async function SchoolContributionCard() {
  const schoolStats = await getSchoolStats()
  if (!schoolStats) return null
  return (
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
  )
}

async function RecentCard() {
  const { recent, schoolMap, creatorMap } = await getRecent()
  return (
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
  )
}

async function MyInflightCard() {
  const rows = await getMyRows()
  const stat = countByFilter(rows)
  const myInflight = rows
    .filter((r) => WORKBENCH_FILTERS.find((f) => f.key === "pending").match(r.displayState))
    .slice(0, 3)
  return (
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
  )
}

export default async function DashboardPage() {
  // 只等鉴权上下文（与布局共用同一次 React cache，不额外打往返）；
  // 姓名在 header 里要用，其余数据全部下沉到各自的 <Suspense>。
  const ctx = await getAuthContext()
  const profile = ctx.profile

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

      {/* ---------- 统计卡：四张各一个边界，骨架先占位，数字各自到各自填 ---------- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Suspense fallback={<StatCardSkeleton />}>
          <BankCountCard />
        </Suspense>
        <Suspense fallback={<StatCardSkeleton />}>
          <MyQuestionsCard />
        </Suspense>
        <Suspense fallback={<StatCardSkeleton />}>
          <WaitingCard isApprover={ctx.isApprover} />
        </Suspense>
        {ctx.isAdmin ? (
          <Suspense fallback={<StatCardSkeleton />}>
            <AdminScaleCard />
          </Suspense>
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
      <Suspense fallback={<SectionSkeleton lines={4} />}>
        <SchoolContributionCard />
      </Suspense>

      {/* ---------- 管理入口（管理角色）：纯 ctx 驱动，无需等待 ---------- */}
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
        <Suspense fallback={<SectionSkeleton lines={3} />}>
          <RecentCard />
        </Suspense>
        <Suspense fallback={<SectionSkeleton lines={3} />}>
          <MyInflightCard />
        </Suspense>
      </div>
    </div>
  )
}
