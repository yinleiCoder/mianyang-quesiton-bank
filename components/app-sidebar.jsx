"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/lib/actions/auth";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { FeedbackDialog } from "@/components/feedback/feedback-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { avatarUrl } from "@/lib/oss-url";
import { ownRoleLabels } from "@/lib/roles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Building2Icon,
  ChevronsUpDownIcon,
  FileTextIcon,
  FileUpIcon,
  GitBranchIcon,
  InboxIcon,
  LayoutDashboardIcon,
  LibraryBigIcon,
  ListChecksIcon,
  LogOutIcon,
  MessageSquareIcon,
  ScrollTextIcon,
  TagsIcon,
  CircleUserRoundIcon,
  DownloadIcon,
  UsersIcon,
} from "lucide-react";

// 注意：本 shadcn 版本基于 Base UI，组合一律用 `render`（不支持 asChild）。
function useNavItems(
  isAdmin,
  isSchoolAdmin,
  isApprover,
  isTeacher,
  openFeedback = 0,
  openReviews = 0,
) {
  // 主菜单随里程碑追加：M4 审批收件箱（组长/专家/管理员见）、M5 全市题库
  // 「我的题目」为教师专属（学生与待审核教师无出题权限，不显示入口）
  const main = [
    { title: "工作台", url: "/dashboard", icon: LayoutDashboardIcon },
    ...(isTeacher
      ? [
          { title: "我的题目", url: "/questions", icon: FileTextIcon },
          // AI 解析也是教师专属：它会生成调用者名下的草稿
          { title: "AI智能解析题库资料", url: "/questions/import", icon: FileUpIcon },
        ]
      : []),
    { title: "题库", url: "/bank", icon: LibraryBigIcon },
  ];
  if (isAdmin || isSchoolAdmin || isApprover) {
    // 角标＝分给我待处理的任务数（Gmail 式），处理完 router.refresh() 会重算
    main.push({
      title: "审批收件箱",
      url: "/review",
      icon: InboxIcon,
      badge: openReviews,
    });
  }
  // 管理台：系统管理员全量；学校管理员仅「本校用户与任命」
  const admin = [];
  if (isAdmin || isSchoolAdmin) {
    if (isAdmin) {
      admin.push(
        { title: "学校管理", url: "/admin/schools", icon: Building2Icon },
        { title: "科目树维护", url: "/admin/tree", icon: GitBranchIcon },
      );
    }
    admin.push({
      title: isAdmin ? "用户与任命" : "本校用户与任命",
      url: "/admin/users",
      icon: UsersIcon,
    });
    if (isAdmin) {
      admin.push(
        { title: "标签管理", url: "/admin/tags", icon: TagsIcon },
        { title: "审批记录", url: "/admin/reviews", icon: ListChecksIcon },
        { title: "审计日志", url: "/admin/audit", icon: ScrollTextIcon },
        // 未处理条数由布局（服务端）传入，处理完 router.refresh() 会重算
        {
          title: "意见反馈",
          url: "/admin/feedback",
          icon: MessageSquareIcon,
          badge: openFeedback,
        },
      );
    }
  }
  return { main, admin };
}

function NavRow({ item, pathname }) {
  const Icon = item.icon;
  const active = pathname === item.url || pathname.startsWith(`${item.url}/`);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton render={<Link href={item.url} />} isActive={active}>
        <Icon className="shrink-0" />
        <span>{item.title}</span>
      </SidebarMenuButton>
      {/* 角标是绝对定位的，必须是按钮的兄弟节点（peer-* 样式靠这个关系生效） */}
      {item.badge > 0 && <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
}

export function AppSidebar({
  user,
  schoolName,
  isAdmin,
  isSchoolAdmin,
  isApprover = false,
  isTeacher = true,
  identity = "teacher",
  openFeedback = 0,
  openReviews = 0,
}) {
  const pathname = usePathname();
  const { isMobile } = useSidebar();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { main: navItems, admin: adminItems } = useNavItems(
    isAdmin,
    isSchoolAdmin,
    isApprover,
    isTeacher,
    openFeedback,
    openReviews,
  );

  // 身份标签（角色可重叠；身份=学生/教师待审核/教师，见 0025）——文案见 lib/roles.js
  const roleLabels = ownRoleLabels({ isAdmin, isSchoolAdmin, identity });
  const subtitle = [schoolName, roleLabels.join(" · ")]
    .filter(Boolean)
    .join(" / ");

  const displayName = user.name || user.email.split("@")[0] || "用户";
  const initial = displayName.trim().slice(0, 1) || "?";

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
              {/* 收折成图标栏时容器缩到侧栏内容框，避免 logo 被裁切 */}
              <div className="flex aspect-square size-8 shrink-0 items-center justify-center group-data-[collapsible=icon]:size-full">
                <img
                  src="/mianyang.svg"
                  alt=""
                  width={32}
                  height={32}
                  className="size-full object-contain"
                />
              </div>
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">
                  绵阳市中职共建题库
                </span>
                <span className="truncate text-xs">多校共建 · 全市共享</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {navItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>导航</SidebarGroupLabel>
            <SidebarMenu>
              {navItems.map((item) => (
                <NavRow key={item.url} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {adminItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>管理台</SidebarGroupLabel>
            <SidebarMenu>
              {adminItems.map((item) => (
                <NavRow key={item.url} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton size="lg">
                    <Avatar className="size-8 shrink-0 rounded-lg">
                      {user.avatarUrl && (
                        <AvatarImage
                          src={avatarUrl(user.avatarUrl)}
                          alt={displayName}
                        />
                      )}
                      <AvatarFallback className="rounded-lg text-sm">
                        {initial}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">
                        {displayName}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {subtitle}
                      </span>
                    </div>
                    <ChevronsUpDownIcon className="ml-auto size-4 shrink-0" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent
                className="min-w-56 rounded-lg"
                side={isMobile ? "bottom" : "right"}
                align="end"
                sideOffset={4}
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="p-0 font-normal">
                    <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                      <Avatar className="size-8 shrink-0 rounded-lg">
                        {user.avatarUrl && (
                          <AvatarImage
                            src={avatarUrl(user.avatarUrl)}
                            alt={displayName}
                          />
                        )}
                        <AvatarFallback className="rounded-lg text-sm">
                          {initial}
                        </AvatarFallback>
                      </Avatar>
                      <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-medium">
                          {displayName}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {user.email}
                        </span>
                      </div>
                    </div>
                    {/* 角色：菜单项上方，与侧栏副标题同口径（ownRoleLabels） */}
                    <div className="flex flex-wrap gap-1 px-1 pb-1.5">
                      {roleLabels.map((label) => (
                        <Badge
                          key={label}
                          variant="secondary"
                          className="font-normal"
                        >
                          {label}
                        </Badge>
                      ))}
                    </div>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem render={<Link href="/profile" />}>
                  <CircleUserRoundIcon />
                  个人资料
                </DropdownMenuItem>
                {/* 客户端下载页是公开页：学生没账号也能拿到安装包，老师在这里顺手转发 */}
                <DropdownMenuItem render={<Link href="/download" />}>
                  <DownloadIcon />
                 下载客户端
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFeedbackOpen(true)}>
                  <MessageSquareIcon />
                  意见反馈
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => signOut()}>
                  <LogOutIcon />
                  退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      {/* 弹窗必须挂在 DropdownMenuContent 之外：菜单一关它的内容就被卸载了。
          条件挂载（而非传 open）是 ConfirmDialog 定下的约定，避免空数据上的记忆化比较。 */}
      {feedbackOpen && (
        <FeedbackDialog onClose={() => setFeedbackOpen(false)} />
      )}
    </Sidebar>
  );
}
