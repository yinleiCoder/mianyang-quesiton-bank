// 审批收件箱：我的待办 + 已处理 + 管理员管理视图（学校管理员=本校；系统管理员=全量含待指派）
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadInbox } from "@/lib/review-workbench"
import { ReviewInbox } from "@/components/review/review-inbox"
import { PageHeader } from "@/components/page-header"

export const metadata = { title: "审批收件箱" }

export default async function ReviewPage() {
  const ctx = await requireUser()
  const supabase = await createClient()
  const { mineRows, decidedRows, manageRows } = await loadInbox(
    supabase,
    ctx.user.id,
    ctx.isAdmin ? "admin" : ctx.isSchoolAdmin ? "school" : null,
    ctx.profile?.school_id
  )

  const canManage = ctx.isAdmin || ctx.isSchoolAdmin

  return (
    <div className="space-y-4">
      <PageHeader
        title="审批收件箱"
        description={
          ctx.isAdmin || ctx.isSchoolAdmin
            ? "审批与转派在此统一收口；退回将回到作者并全链重审。"
            : "逐题审阅后通过或退回（退回必填意见）；也可到题目详情发起转派。"
        }
      />
      <ReviewInbox mineRows={mineRows} decidedRows={decidedRows} manageRows={manageRows} canManage={canManage} />
    </div>
  )
}
