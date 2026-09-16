// 受保护应用外壳：这里才做真正的鉴权（proxy.ts 只是乐观跳转，非安全边界）。
// 布局为 Server Component：先只做本地验签把外壳刷出去，再把要打网络的侧栏数据流式补上。
import { Suspense } from "react"
import { requireSession, requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadSchools, schoolNameOf } from "@/lib/reference-data"
import { loadOpenFeedbackCount } from "@/lib/feedback"
import { AppBreadcrumb } from "@/components/app-breadcrumb"
import { AppSidebar } from "@/components/app-sidebar"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"

export default async function AppLayout({ children }) {
  // 闸门留在 shell 之前，但只花**本地**验签的时间（requireSession，0 往返）。
  // 档案 / 学校名 / 反馈角标这些真打网络的活全部推进下面的 Suspense：
  // 侧栏骨架与 <main> 里的页面骨架能立刻刷出去，而不是干等一整轮 Supabase 往返。
  // 判定条件与原先的 requireUser() 一致，谁会被踢去登录页没有变化。
  await requireSession()

  return (
    <SidebarProvider>
      <Suspense fallback={<AppSidebarSkeleton />}>
        <AppSidebarData />
      </Suspense>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-auto"
          />
          <AppBreadcrumb />
        </header>
        <main className="flex flex-1 flex-col gap-6 p-4 lg:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}

// 侧栏的数据 + 渲染：档案、学校名、未处理反馈角标都要打网络，整块进 Suspense。
// 这里调 requireUser()，与页面里各自的 requireUser() 共用同一次 React cache，
// 不会因此多打一次 auth_context（见 lib/auth.js）。
async function AppSidebarData() {
  const ctx = await requireUser()
  const profile = ctx.profile

  // 学校名走缓存的参考数据：每个页面都要用的一份名单，不该每次页面加载都打一次往返。
  let schoolName = null
  let openFeedback = 0
  let openReviews = 0
  if (profile?.school_id) {
    schoolName = schoolNameOf(await loadSchools(), profile.school_id)
  }
  // 两个角标（反馈收件箱 / 我的待办）是装饰性的：查询失败不该让所有页面跟着进错误边界，退回 0 即可
  const needsCounts = ctx.isAdmin || ctx.isApprover || ctx.isSchoolAdmin
  if (needsCounts) {
    const supabase = await createClient()
    // 审批收件箱角标（Gmail 式）＝ 分给我的待处理审批任务数。只取 count、不取行：
    // 走 idx_approvals_inbox 那条部分索引，比拉一遍列表便宜得多。
    // 组长/专家/管理员之外的账号没有这条导航，也就不查。
    try {
      const { count } = await supabase
        .from("approvals")
        .select("id", { count: "exact", head: true })
        .eq("assigned_user_id", ctx.user.id)
        .eq("state", "waiting")
      openReviews = count ?? 0
    } catch {
      openReviews = 0
    }
    if (ctx.isAdmin) {
      try {
        openFeedback = await loadOpenFeedbackCount(supabase)
      } catch {
        openFeedback = 0
      }
    }
  }

  return (
    <AppSidebar
      user={{
        name: profile?.name ?? "",
        email: ctx.user.email ?? "",
        avatarUrl: profile?.avatar_url ?? null,
      }}
      schoolName={schoolName}
      isAdmin={ctx.isAdmin}
      isSchoolAdmin={ctx.isSchoolAdmin}
      isApprover={ctx.isApprover}
      isTeacher={ctx.isTeacher}
      identity={ctx.identity}
      openFeedback={openFeedback}
      openReviews={openReviews}
    />
  )
}

// 与真侧栏同宽同结构（variant="inset" collapsible="icon"），尺寸对齐以免内容到位时抖动。
function AppSidebarSkeleton() {
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 rounded-md p-2">
          <div className="aspect-square size-8 shrink-0 animate-pulse rounded-md bg-sidebar-accent" />
          <div className="grid flex-1 gap-1.5 group-data-[collapsible=icon]:hidden">
            <div className="h-3 w-24 animate-pulse rounded bg-sidebar-accent" />
            <div className="h-2.5 w-16 animate-pulse rounded bg-sidebar-accent" />
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {[0, 1, 2, 3].map((i) => (
              <SidebarMenuItem key={i}>
                <div className="flex h-8 items-center gap-2 rounded-md px-2">
                  <div className="size-4 shrink-0 animate-pulse rounded bg-sidebar-accent" />
                  <div className="h-3 flex-1 animate-pulse rounded bg-sidebar-accent group-data-[collapsible=icon]:hidden" />
                </div>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
