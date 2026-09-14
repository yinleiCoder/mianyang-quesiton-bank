// 审批记录（系统管理员）：全量任务流水 + 状态筛选；待处理任务可在此转派/指派（DB 校验权限）。
// 学校管理员的"本校在途任务"仍走 /review 管理视图（此处不做学校范围，避免重复入口）。
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadReviewRecords } from "@/lib/admin-records"
import { ReviewHistoryList } from "@/components/admin/review-history-list"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"

export const metadata = { title: "审批记录" }

const TABS = [
  { key: "waiting", label: "待处理" },
  { key: "approved", label: "已通过" },
  { key: "returned", label: "已退回" },
  { key: "cancelled", label: "已取消" },
  { key: "all", label: "全部" },
]

export default async function AdminReviewsPage({ searchParams }) {
  const ctx = await requireUser()
  if (!ctx.isAdmin) {
    return <AccessDenied title="仅系统管理员可见" description="审批记录展示全市全部审批任务流水，含已决记录与批注。" />
  }
  const supabase = await createClient()
  const sp = (await searchParams) ?? {}
  const state = TABS.some((t) => t.key === sp.st) ? sp.st : "waiting"

  const [rows, usersRes, schoolsRes] = await Promise.all([
    loadReviewRecords(supabase, { state, limit: 100 }),
    supabase.from("profiles").select("user_id, name, school_id").order("name"),
    supabase.from("schools").select("id, name"),
  ])
  const schoolName = new Map((schoolsRes.data ?? []).map((s) => [s.id, s.name]))
  const users = (usersRes.data ?? []).map((u) => ({
    id: u.user_id,
    name: u.name,
    schoolName: u.school_id ? (schoolName.get(u.school_id) ?? "") : "",
  }))

  return (
    <div className="space-y-4">
      <PageHeader
        title="审批记录"
        description="全市审批任务流水（最近 100 条/组）。任务处理人于创建时刻快照，任命调整不影响在途任务；无人处理的等待任务（待指派）在此直接指派给对应环节的组长/专家。"
      />

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const active = state === t.key
          return active ? (
            <span
              key={t.key}
              className="rounded-full bg-primary px-3 py-1 text-sm font-medium text-primary-foreground"
            >
              {t.label}
            </span>
          ) : (
            <Link
              key={t.key}
              href={`/admin/reviews?st=${t.key}`}
              className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/60"
            >
              {t.label}
            </Link>
          )
        })}
      </div>

      <ReviewHistoryList rows={rows} users={users} />
    </div>
  )
}
