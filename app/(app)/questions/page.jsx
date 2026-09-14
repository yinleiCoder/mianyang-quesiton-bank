// 我的题目工作台：服务端 seed 行数据（作者本人可见范围，与 RLS 一致），操作在客户端重查刷新
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadMyQuestions } from "@/lib/question-workbench"
import { MyQuestions } from "@/components/questions/my-questions"
import { PageHeader } from "@/components/page-header"

export const metadata = { title: "我的题目" }

export default async function MyQuestionsPage({ searchParams }) {
  const { status } = (await searchParams) ?? {}
  const ctx = await requireUser()
  const supabase = await createClient()
  const { rows } = await loadMyQuestions(supabase, ctx.user.id)

  // 提交/撤回后的落地页签：status=返回版本状态 → 对应筛选
  const initialFilter = { pending_group: "pending", pending_city: "pending", returned: "returned" }[status] ?? "all"

  return (
    <div className="space-y-4">
      <PageHeader
        title="我的题目"
        description={
          <>
            草稿、审核中、已退回与已入库的题目一览。提交后经{" "}
            <span className="font-medium text-foreground">教研组长 → 市级专家 → 入库</span>{" "}
            两级审核；退回按意见修改后重新提交即全链重审。已入库题目可发起改版（新版本重新审批）或申请下线。
          </>
        }
      />
      <MyQuestions initialRows={rows} initialFilter={initialFilter} />
    </div>
  )
}
