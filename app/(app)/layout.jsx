// 受保护应用外壳：这里才做真正的鉴权（proxy.ts 只是乐观跳转，非安全边界）。
// 布局为 Server Component：验会话 → 查学校名 → 把可序列化信息传给客户端侧边栏。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadOpenFeedbackCount } from "@/lib/feedback"
import { AppSidebar } from "@/components/app-sidebar"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"

export default async function AppLayout({ children }) {
  const ctx = await requireUser()
  const profile = ctx.profile

  // 学校名与「未处理反馈」角标共用同一个客户端：任一侧需要就建
  let schoolName = null
  let openFeedback = 0
  if (profile?.school_id || ctx.isAdmin) {
    const supabase = await createClient()
    if (profile?.school_id) {
      const { data } = await supabase
        .from("schools")
        .select("name")
        .eq("id", profile.school_id)
        .maybeSingle()
      schoolName = data?.name ?? null
    }
    if (ctx.isAdmin) {
      // 角标是装饰性的：查询失败不该让所有页面跟着进错误边界，退回 0 即可
      try {
        openFeedback = await loadOpenFeedbackCount(supabase)
      } catch {
        openFeedback = 0
      }
    }
  }

  const sidebarUser = {
    name: profile?.name ?? "",
    email: ctx.user.email ?? "",
    avatarUrl: profile?.avatar_url ?? null,
  }

  return (
    <SidebarProvider>
      <AppSidebar
        user={sidebarUser}
        schoolName={schoolName}
        isAdmin={ctx.isAdmin}
        isSchoolAdmin={ctx.isSchoolAdmin}
        isApprover={ctx.isApprover}
        isTeacher={ctx.isTeacher}
        identity={ctx.identity}
        openFeedback={openFeedback}
        roles={ctx.roles}
      />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-auto"
          />
          <span className="text-sm font-medium text-muted-foreground">
            绵阳市中职共建题库
          </span>
        </header>
        <main className="flex flex-1 flex-col gap-6 p-4 lg:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
