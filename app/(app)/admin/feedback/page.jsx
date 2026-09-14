// 意见反馈收件箱（系统管理员）：看用户从网页端/App 提交的反馈，标记已处理。
// 只有系统管理员能读这张表（0033 的 select_admin 策略），这里的守卫是页面体验层，不是安全边界。
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { FEEDBACK_FILTERS, loadFeedbackInbox, loadOpenFeedbackCount } from "@/lib/feedback"
import { FeedbackInbox } from "@/components/admin/feedback-inbox"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"

export const metadata = { title: "意见反馈" }

export default async function AdminFeedbackPage({ searchParams }) {
  const ctx = await requireUser()
  if (!ctx.isAdmin) {
    return (
      <AccessDenied
        title="仅系统管理员可见"
        description="意见反馈收件箱包含提交人的联系方式与处理记录，仅系统管理员可见。"
      />
    )
  }
  const sp = (await searchParams) ?? {}
  const status = FEEDBACK_FILTERS.some((f) => f.key === sp.status) ? sp.status : "open"

  const supabase = await createClient()
  const [rows, openCount] = await Promise.all([
    loadFeedbackInbox(supabase, { status }),
    loadOpenFeedbackCount(supabase),
  ])

  return (
    <div className="space-y-4">
      <PageHeader
        title="意见反馈"
        description={
          openCount > 0
            ? `用户提交的使用反馈：待处理 ${openCount} 条。本功能没有回复流，需要跟进的请按行上的联系方式线下联系。`
            : "用户提交的使用反馈：当前没有待处理的反馈。"
        }
      />

      <div className="flex flex-wrap gap-1.5">
        {FEEDBACK_FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/admin/feedback?status=${f.key}`}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              status === f.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/60"
            }`}
          >
            {f.label}
            {f.key === "open" && openCount > 0 && <span className="ml-1 opacity-70">{openCount}</span>}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
          {status === "open" ? "没有待处理的反馈" : "暂无反馈记录"}
        </p>
      ) : (
        <FeedbackInbox rows={rows} />
      )}
    </div>
  )
}
