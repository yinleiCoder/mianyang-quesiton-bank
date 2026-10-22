// 我的题目工作台：服务端 seed 行数据（作者本人可见范围，与 RLS 一致），操作在客户端重查刷新
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadMyQuestions } from "@/lib/question-workbench"
import { loadMyPublishableIds } from "@/lib/review-workbench"
import { MyQuestions } from "@/components/questions/my-questions"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"

export const metadata = { title: "我的题目" }

export default async function MyQuestionsPage({ searchParams }) {
  const { status } = (await searchParams) ?? {}
  const ctx = await requireUser()
  // 「我的题目」是出题工作台：学生/待审核教师没有题目可管理，直接挡在门外。
  // 侧栏入口本来就不给他们显示，但直接输 URL 仍会到这里 —— 页面守卫才是那条线。
  if (!ctx.isTeacher) {
    return (
      <AccessDenied
        title="仅教师可用"
        description="「我的题目」管理的是教师创作的题目。学生账号请到题库浏览，或在客户端刷题练习。"
      />
    )
  }
  const supabase = await createClient()
  // 两件事互不依赖：行数据（我的题）与待我入库的任务（专家账号才有，其余人恒为空）
  const [{ rows }, publishableIds] = await Promise.all([
    loadMyQuestions(supabase, ctx.user.id),
    loadMyPublishableIds(supabase, ctx.user.id),
  ])

  // 提交/撤回/恢复后的落地页签：status=返回版本状态 → 对应筛选。
  // draft/retracted 也要映射：组卷页的「去我的题目看草稿」带 status=draft，
  // 审批详情页撤回后也带 status=draft 回来。
  const initialFilter =
    {
      draft: "draft",
      pending_group: "pending",
      pending_city: "pending",
      returned: "returned",
      retracted: "retracted",
    }[status] ?? "all"

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
      <MyQuestions
        initialRows={rows}
        initialFilter={initialFilter}
        publishableIds={publishableIds}
      />
    </div>
  )
}
