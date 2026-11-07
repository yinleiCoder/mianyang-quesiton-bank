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
import { displayIdentifier } from "@/lib/phone";
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
  BrainCircuitIcon,
  Building2Icon,
  ChevronsUpDownIcon,
  ClapperboardIcon,
  ClipboardCheckIcon,
  FileTextIcon,
  FileStackIcon,
  FileUpIcon,
  FlagIcon,
  FolderDownIcon,
  GitBranchIcon,
  GraduationCapIcon,
  InboxIcon,
  LayoutDashboardIcon,
  LibraryBigIcon,
  ListChecksIcon,
  LogOutIcon,
  MapPinIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  ScrollTextIcon,
  Settings2Icon,
  SparklesIcon,
  TagsIcon,
  CircleUserRoundIcon,
  DownloadIcon,
  UsersIcon,
  UsersRoundIcon,
  WorkflowIcon,
} from "lucide-react";

// 注意：本 shadcn 版本基于 Base UI，组合一律用 `render`（不支持 asChild）。
function useNavItems(
  isAdmin,
  isSchoolAdmin,
  isApprover,
  isTeacher,
  openFeedback = 0,
  openReviews = 0,
  openReports = 0,
  openPaperTasks = 0,
  openGrading = 0,
) {
  // 侧栏共五组（自上而下）：导航 / AI与科技教育 / 管理台 / 我的工作 / 软件架构讲解。
  // 分组口径（2026-11-05 用户定）：
  //   导航      —— 人人都用的内容入口（题库、组卷库、资料）
  //   AI与科技教育 —— AI 相关配置与入口，放在管理台上方
  //   管理台    —— 只有管理员/学校管理员看得见，所以这一组的**存在本身**就是角色闸门
  //   我的工作  —— 我自己的题目与待办（教师/审批人/管理员各一部分）
  //   软件架构讲解 —— 只读展示页，不做角色分叉
  const main = [
    { title: "工作台", url: "/dashboard", icon: LayoutDashboardIcon },
    // 题目反馈（学生纠错）的处理入口。
    // **不能塞进 isTeacher 判断** —— 学校管理员未必是教师身份，
    // 但作者离职后正是他们兜底处理，漏掉就等于那条链路没人管。
    ...(isTeacher || isSchoolAdmin || isAdmin
      ? [
          {
            title: "题目反馈",
            url: "/questions/reports",
            icon: FlagIcon,
            badge: openReports,
          },
        ]
      : []),
    { title: "题库", url: "/bank", icon: LibraryBigIcon },
    // 组卷库对所有登录用户可见（与题库同口径：已入库试卷全市共享，学生也能看）。
    // 角标 = 别人分给我的子卷任务（0085 协同组卷）——**这是被指派人唯一会主动看到的通知**，
    // 没有它就得自己去「我参与的」翻。点进组卷库后第一个页签就是它。
    { title: "组卷库", url: "/papers", icon: FileStackIcon, badge: openPaperTasks },
    // 复习资料：全市共享，所有登录用户都能看；上传/删除按钮由页面按角色与归属画。
    // 形状与题库一致 —— 内容型入口，不做角色分叉。
    { title: "复习资料", url: "/materials", icon: FolderDownIcon },
    // 学生名册：2026-11-05 起管理台角色（管理员/学校管理员）的那一份挪进了「管理台」分组；
    // 普通教师没有管理台，这里保留「我的学生」，否则他就失去了看本专业学生的入口。
    ...(isTeacher && !isAdmin && !isSchoolAdmin
      ? [{ title: "我的学生", url: "/students", icon: GraduationCapIcon }]
      : []),
  ];

  // AI 与科技教育：排在「管理台」上方（2026-11-05 用户定的分组）。
  const ai = [
    // AI 配置：全站 AI 功能共用的密钥/模型入口。只对教师/管理员可见；
    // 学生端不需要密钥（学习路径是确定性算法，不调用大模型）。
    ...(isTeacher || isSchoolAdmin || isAdmin
      ? [
          {
            title: "AI 配置",
            url: "/settings/ai",
            icon: Settings2Icon,
            tooltip: "AI 配置（密钥只存本机浏览器）",
          },
        ]
      : []),
    // 站外入口：学生遇到不会的题可以拿去问秘塔 AI 搜索。external 让 NavRow 用新标签页打开，
    // 且不参与"当前在哪一页"的高亮（它不是本站路由）。
    {
      title: "AI 答疑",
      url: "https://metaso.cn/",
      icon: SparklesIcon,
      external: true,
    },
    // AI 解析是教师专属：它会生成调用者名下的草稿
    ...(isTeacher
      ? [{ title: "AI智能解析题库资料", url: "/questions/import", icon: FileUpIcon }]
      : []),
  ];

  // 我的工作：排在「管理台」下方（2026-11-05 用户定的分组）。
  const work = [
    // 「我的题目」为教师专属（学生与待审核教师无出题权限，不显示入口）
    ...(isTeacher
      ? [{ title: "我的题目", url: "/questions", icon: FileTextIcon }]
      : []),
    // 阅卷队列（2026-11-05）：入口以前只藏在「试卷详情 → 阅卷」里，教师得先知道
    // 是哪份卷子；学生一交卷也没有任何地方汇总"还有几场没批"。
    // 权限由 list_my_grading_queue 里的 can_user_grade_attempt 收口（0148），
    // 角标＝我认领的待批 + 我能认领的未认领。
    ...(isTeacher || isSchoolAdmin || isAdmin
      ? [{ title: "阅卷", url: "/grading", icon: ClipboardCheckIcon, badge: openGrading }]
      : []),
    // 角标＝分给我待处理的任务数（Gmail 式），处理完 router.refresh() 会重算
    ...(isAdmin || isSchoolAdmin || isApprover
      ? [
          {
            title: "审批收件箱",
            url: "/review",
            icon: InboxIcon,
            badge: openReviews,
          },
        ]
      : []),
    // 审批记录 / 审计日志：2026-11-05 从「管理台」挪到「我的工作」。
    ...(isAdmin
      ? [
          { title: "审批记录", url: "/admin/reviews", icon: ListChecksIcon },
          { title: "审计日志", url: "/admin/audit", icon: ScrollTextIcon },
        ]
      : []),
  ];
  // 管理台：系统管理员全量；学校管理员仅「本校用户与任命」
  const admin = [];
  if (isAdmin || isSchoolAdmin) {
    if (isAdmin) {
      admin.push(
        // 市在学校之上：先建市，学校才挂得上（0082）
        { title: "市管理", url: "/admin/cities", icon: MapPinIcon },
        { title: "学校管理", url: "/admin/schools", icon: Building2Icon },
        { title: "科目树维护", url: "/admin/tree", icon: GitBranchIcon },
      );
    }
    admin.push({
      title: isAdmin ? "用户与任命" : "本校用户与任命",
      url: "/admin/users",
      icon: UsersIcon,
    });
    // 班级建设：与系统管理员的「科目树维护」（专业建设）并列，各管一层
    admin.push({ title: "班级管理", url: "/admin/classes", icon: UsersRoundIcon });
    // 学生名册（2026-11-05 从「导航」挪进来）：能看见管理台的角色都带学生管理属性。
    // 标签按角色变 —— 同一条路由两种口径，服务端各自筛各自的（见 lib/students.js）。
    admin.push({
      title: isAdmin ? "学生名册" : "本校学生",
      url: "/students",
      icon: GraduationCapIcon,
    });
    if (isAdmin) {
      admin.push(
        { title: "知识点管理", url: "/admin/tags", icon: TagsIcon },
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
  // 软件架构讲解：与「管理台」并列的**第三组**，但**不做角色分叉** ——
  // 这些页面全是只读展示、不读业务数据，学生和教师也需要看得到。
  // 长标题在侧栏会被 truncate，由 NavRow 的 title 属性与 tooltip 兜底。
  const showcase = [
    {
      title: "软件宣传展示",
      url: "/showcase/promo",
      icon: MegaphoneIcon,
      tooltip: "软件宣传展示",
    },
    {
      title: "软件架构与人员层级管理结构流程图",
      url: "/showcase/architecture",
      icon: WorkflowIcon,
      tooltip: "软件架构与人员层级管理结构流程图",
    },
    {
      title: "软件架构及人员管理动画",
      url: "/showcase/animation",
      icon: ClapperboardIcon,
      tooltip: "软件架构及人员管理动画",
    },
    {
      title: "AI 算法说明",
      url: "/showcase/algorithms",
      icon: SparklesIcon,
      tooltip: "LLM / 模拟退火 / BKT / FSRS / CTT / 查重 / 画像六轴",
    },
    {
      title: "科学抽题算法动画",
      url: "/showcase/scheduler",
      icon: BrainCircuitIcon,
      tooltip: "科学抽题算法动画（FSRS-6 + BKT）",
    },
  ];

  return { main, ai, admin, work, showcase };
}

function NavRow({ item, pathname }) {
  const Icon = item.icon;
  // 站外链接不参与高亮，也不能用 next/link（它会去 prefetch 一个外域路由）
  const active =
    !item.external && (pathname === item.url || pathname.startsWith(`${item.url}/`));
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={
          item.external ? (
            <a href={item.url} target="_blank" rel="noreferrer" />
          ) : (
            <Link href={item.url} />
          )
        }
        isActive={active}
        tooltip={item.tooltip}
        title={item.title}
      >
        <Icon className="shrink-0" />
        <span title={item.title}>{item.title}</span>
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
  openReports = 0,
  openPaperTasks = 0,
  openGrading = 0,
}) {
  const pathname = usePathname();
  const { isMobile } = useSidebar();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const {
    main: navItems,
    ai: aiItems,
    admin: adminItems,
    work: workItems,
    showcase: showcaseItems,
  } = useNavItems(
    isAdmin,
    isSchoolAdmin,
    isApprover,
    isTeacher,
    openFeedback,
    openReviews,
    openReports,
    openPaperTasks,
    openGrading,
  );

  // 身份标签（角色可重叠；身份=学生/教师待审核/教师，见 0025）——文案见 lib/roles.js
  const roleLabels = ownRoleLabels({ isAdmin, isSchoolAdmin, identity });
  const subtitle = [schoolName, roleLabels.join(" · ")]
    .filter(Boolean)
    .join(" / ");

  // 姓名兜底：手机号账号没有邮箱，退到 email 的本地部分会拿到一段数字（合成地址的
  // `13800138000`），虽然能用但语义是错的 —— 所以先试手机号。
  const displayName = user.name || user.phone || user.email.split("@")[0] || "用户";
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
                  职教高考联盟
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
        {aiItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>AI与科技教育</SidebarGroupLabel>
            <SidebarMenu>
              {aiItems.map((item) => (
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
        {workItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>我的工作</SidebarGroupLabel>
            <SidebarMenu>
              {workItems.map((item) => (
                <NavRow key={item.url} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {showcaseItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>软件架构讲解</SidebarGroupLabel>
            <SidebarMenu>
              {showcaseItems.map((item) => (
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
                          {displayIdentifier({ phone: user.phone, email: user.email })}
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
