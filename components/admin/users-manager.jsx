"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { TreePicker } from "@/components/admin/tree-picker"
import { indexNodes } from "@/lib/subject-nodes"
import { loadAdminUserDirectory } from "@/lib/admin-users"
import { avatarUrl } from "@/lib/oss-url"
import { fmtDateTime24 } from "@/lib/format"
import {
  Building2Icon,
  CrownIcon,
  GraduationCapIcon,
  IdCardIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  SearchIcon,
  Trash2Icon,
  UserCogIcon,
  UserPlusIcon,
  UserRoundCheckIcon,
  UserRoundXIcon,
  UsersIcon,
} from "lucide-react"

const SCHOOL_ADMIN_ROLE = "school_admin"
const schoolOf = (map, id) => (id ? (map.get(id)?.name ?? null) : null)
// 本页**不含学生**：identity='student' 归「学生名册」（/students），由 lib/admin-users.js 的
// neq("identity","student") 保证。所以这里不再有 isStudent 分支 —— 别再加回来，
// 那会把两边的口径重新搅在一起（学生转教师后自动换边，两边互补且互斥）。
const identityLabel = (u) =>
  u.identity === "teacher_pending" ? "教师（待审核）" : "教师"
// 资料弹窗里的一句话说明：三态身份的差别就在"能不能出题/被任命"
const PROFILE_HINTS = {
  student: "学生账号：只参与练习与考试，不参与出题、审核与任命。",
  teacher_pending: "教师账号（待审核）：通过教师身份审核后才能出题。",
  teacher: "教师账号：可出题、组卷，并可被任命为教研组长 / 市级专家。",
}

// 任教专业决定该教师能在「学生名册」里看到哪些学生（见 0063 的 can_view_student）。
// 只有教师需要它 —— 管理员不靠专业限定范围。
const canSetMajor = (u, caller) =>
  !u.is_admin &&
  u.identity !== "student" &&
  Boolean(u.school_id) &&
  (caller.isAdmin ||
    (caller.isSchoolAdmin && u.school_id === caller.schoolId))

export function UsersManager({
  users: initialUsers,
  schools: initialSchools,
  roleRows: initialRoleRows,
  assignments: initialAssignments,
  nodes: initialNodes,
  caller,
}) {
  // 数据自管理：初始值由服务端传入（SSR 首屏），操作成功后浏览器端重查（不依赖 router.refresh）
  const [users, setUsers] = useState(initialUsers)
  const [schools, setSchools] = useState(initialSchools)
  const [roleRows, setRoleRows] = useState(initialRoleRows)
  const [assignments, setAssignments] = useState(initialAssignments)
  const [nodes, setNodes] = useState(initialNodes)
  const [q, setQ] = useState("")

  const schoolMap = useMemo(() => new Map(schools.map((s) => [s.id, s])), [schools])
  const schoolAdmins = useMemo(
    () => new Set(roleRows.filter((r) => r.role === SCHOOL_ADMIN_ROLE).map((r) => r.user_id)),
    [roleRows]
  )

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return users
    return users.filter(
      (u) => u.name?.toLowerCase().includes(s) || u.email?.toLowerCase().includes(s)
    )
  }, [users, q])

  // 重查全量展示数据（与页面 SSR 同一装载函数；查询失败的字段保留旧值）
  async function refetchAll() {
    const next = await loadAdminUserDirectory(createClient(), caller)
    if (next.profiles) setUsers(next.profiles)
    if (next.schools) setSchools(next.schools)
    if (next.roleRows) setRoleRows(next.roleRows)
    setAssignments(next.assignments)
    if (next.nodes) setNodes(next.nodes)
  }

  async function runRpc(fnName, params, successMsg) {
    const supabase = createClient()
    const { error } = await supabase.rpc(fnName, params)
    if (error) {
      toast.error(error.message)
      return false
    }
    toast.success(successMsg)
    await refetchAll()
    return true
  }

  if (users.length === 0) {
    return (
      <EmptyState
        icon={UsersIcon}
        title="暂无用户"
        description={
          caller.isAdmin
            ? "教师注册后会自动出现在这里。先到「学校管理」建好学校，再去「科目树维护」建科目。"
            : "本校还没有教师注册。可到注册页绑定学校后等待加入。"
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-full max-w-xs">
          <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="搜索姓名或邮箱"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <p className="text-sm text-muted-foreground">共 {users.length} 位用户</p>
      </div>
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>学校</TableHead>
              <TableHead className="min-w-52">身份与任命</TableHead>
              <TableHead className="w-16 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((u) => (
              <UserRow
                key={u.user_id}
                user={u}
                schoolMap={schoolMap}
                schoolAdmins={schoolAdmins}
                assignments={assignments.filter((a) => a.user_id === u.user_id)}
                nodes={nodes}
                caller={caller}
                onRpc={runRpc}
                canBindSchool={caller.isAdmin}
                canToggleSA={caller.isAdmin && !u.is_admin}
                canAssignLeader={
                  !u.is_admin &&
                  Boolean(u.school_id) &&
                  caller.isSchoolAdmin &&
                  u.school_id === caller.schoolId
                }
                canAssignExpert={caller.isAdmin && !u.is_admin}
                canSetMajor={canSetMajor(u, caller)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function UserRow({
  user: u,
  schoolMap,
  schoolAdmins,
  assignments,
  nodes,
  caller,
  onRpc,
  canBindSchool,
  canToggleSA,
  canAssignLeader,
  canAssignExpert,
  canSetMajor,
}) {
  const [bindOpen, setBindOpen] = useState(false)
  const [bindSchool, setBindSchool] = useState("")
  const [bindBusy, setBindBusy] = useState(false)
  const [saConfirm, setSaConfirm] = useState(false)
  const [saBusy, setSaBusy] = useState(false)
  const [picker, setPicker] = useState(null) // { role: 'group_leader' | 'city_expert' } 或 null
  const [majorOpen, setMajorOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [revokeId, setRevokeId] = useState(null)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const [delBusy, setDelBusy] = useState(false)
  const [busyAction, setBusyAction] = useState("")

  const isSchoolAdminNow = schoolAdmins.has(u.user_id)
  const activeSchools = [...schoolMap.values()].filter((s) => s.is_active)
  const initial = (u.name || "?").slice(0, 1)
  const pathOf = useMemo(() => indexNodes(nodes).pathOf, [nodes])

  // 停用权限同样按分工：专家→系统管理员；组长→该校学校管理员
  const revocable = assignments.filter((a) => {
    if (a.role === "city_expert") return caller.isAdmin
    return caller.isSchoolAdmin && a.school_id === caller.schoolId
  })

  async function doBind() {
    // 未选学校时给出提示，不要静默返回（用户会以为点了没反应）
    if (!bindSchool) {
      toast.warning("请先选择学校")
      return
    }
    setBindBusy(true)
    const ok = await onRpc("admin_set_user_school", { p_user_id: u.user_id, p_school_id: bindSchool }, "已更新绑定学校")
    setBindBusy(false)
    if (ok) setBindOpen(false)
  }

  async function doToggleSA() {
    setSaBusy(true)
    const ok = await onRpc(
      isSchoolAdminNow ? "admin_revoke_school_admin" : "admin_assign_school_admin",
      { p_user_id: u.user_id },
      isSchoolAdminNow ? "已撤销学校管理员" : "已任命为学校管理员"
    )
    setSaBusy(false)
    if (ok) setSaConfirm(false)
  }

  async function doRevoke() {
    setRevokeBusy(true)
    const ok = await onRpc("revoke_approver", { p_assignment_id: revokeId }, "已停用该任命")
    setRevokeBusy(false)
    if (ok) setRevokeId(null)
  }

  async function doDelete() {
    setDelBusy(true)
    const ok = await onRpc("admin_delete_user", { p_user_id: u.user_id }, "已删除该用户")
    setDelBusy(false)
    if (ok) setDelOpen(false)
  }

  async function handleNodePick(node) {
    if (majorOpen) {
      setBusyAction("major")
      const ok = await onRpc(
        "admin_set_teacher_major",
        { p_user_id: u.user_id, p_major_node_id: node.id },
        "任教专业已设置"
      )
      setBusyAction("")
      if (ok) setMajorOpen(false)
      return
    }
    if (!picker) return
    setBusyAction("assign")
    const fn =
      picker.role === "group_leader" ? "assign_group_leader" : "assign_city_expert"
    const msg = picker.role === "group_leader" ? "教研组长已任命" : "市级专家已任命"
    const ok = await onRpc(fn, { p_user_id: u.user_id, p_node_id: node.id }, msg)
    setBusyAction("")
    if (ok) setPicker(null)
  }

  const menuBlocked = u.is_admin
  // 删除授权与服务端 admin_delete_user 一致：
  // 系统管理员可删任意非系统管理员（非自己）；学校管理员仅可删本校非管理员/非在任专家的教师
  const hasActiveCityExpert = assignments.some((a) => a.role === "city_expert")
  const canDelete = Boolean(
    caller.meId !== u.user_id &&
      !u.is_admin &&
      (caller.isAdmin ||
        (caller.isSchoolAdmin &&
          u.school_id === caller.schoolId &&
          !isSchoolAdminNow &&
          !hasActiveCityExpert))
  )
  const canAny =
    canBindSchool ||
    canToggleSA ||
    canAssignLeader ||
    canAssignExpert ||
    canSetMajor ||
    revocable.length > 0 ||
    canDelete

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-3">
            {/* 有头像就显示头像，没上传过才退回姓名首字（与侧栏/题库 chips 同一套 Avatar 组件） */}
            <Avatar className="size-8 shrink-0">
              {u.avatar_url && <AvatarImage src={avatarUrl(u.avatar_url)} alt={u.name || ""} />}
              <AvatarFallback className="font-semibold">{initial}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 truncate font-medium">
                {u.name}
                {u.is_admin && <CrownIcon className="size-3.5 text-amber-500" />}
              </p>
              <p className="truncate text-xs text-muted-foreground">{u.email}</p>
            </div>
          </div>
        </TableCell>
        <TableCell>
          <span className="text-sm text-muted-foreground">
            {schoolOf(schoolMap, u.school_id) ?? <span className="text-amber-600">未绑定</span>}
          </span>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1.5">
            {u.is_admin && <Badge>系统管理员</Badge>}
            {isSchoolAdminNow && <Badge variant="secondary">学校管理员</Badge>}
            {assignments.map((a) => {
              const path = pathOf(a.node_id) || "?"
              const title = a.role === "group_leader" ? "教研组长" : "市级专家"
              return (
                <Badge key={a.id} variant="outline" className="max-w-full" title={path}>
                  <span className="truncate">
                    {title} · {a.role === "group_leader" ? schoolOf(schoolMap, a.school_id) ?? "?" : ""}
                    {a.role === "group_leader" ? " / " : ""}
                    {path}
                  </span>
                </Badge>
              )
            })}
            {u.identity === "teacher_pending" && (
              <Badge className="bg-amber-100 text-amber-700">教师（待审核）</Badge>
            )}
            {/* 任教专业：没设置就不显示 —— 用「未设置」占满列宽只会淹没真正有信息的行 */}
            {u.major_node_id && (
              <Badge variant="outline" className="max-w-full" title={pathOf(u.major_node_id)}>
                <span className="truncate">专业 · {pathOf(u.major_node_id) || "?"}</span>
              </Badge>
            )}
            {!u.is_admin &&
              !isSchoolAdminNow &&
              assignments.length === 0 &&
              u.identity !== "teacher_pending" && (
                <span className="text-xs text-muted-foreground">教师</span>
              )}
          </div>
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            {!menuBlocked && canAny && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon" className="size-8">
                      <MoreHorizontalIcon className="size-4" />
                      <span className="sr-only">操作</span>
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="min-w-52">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{u.name} · 操作</DropdownMenuLabel>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setProfileOpen(true)}>
                    <IdCardIcon /> 查看资料
                  </DropdownMenuItem>
                  {canSetMajor && (
                    <DropdownMenuItem onClick={() => setMajorOpen(true)}>
                      <GraduationCapIcon /> 设置任教专业…
                    </DropdownMenuItem>
                  )}
                  {canBindSchool && (
                    <DropdownMenuItem
                      onClick={() => {
                        // 预填当前学校：否则 Select 显示的是用户现校、state 却是空串，
                        // 直接点「保存」会被 doBind 的空值判断静默吞掉（什么都不发生）
                        setBindSchool(u.school_id ?? "")
                        setBindOpen(true)
                      }}
                    >
                      <Building2Icon /> {u.school_id ? "更换绑定学校" : "绑定学校"}
                    </DropdownMenuItem>
                  )}
                  {canToggleSA && (
                    <DropdownMenuItem onClick={() => setSaConfirm(true)}>
                      {isSchoolAdminNow ? <UserRoundXIcon /> : <UserRoundCheckIcon />}
                      {isSchoolAdminNow ? "撤销学校管理员" : "任命学校管理员"}
                    </DropdownMenuItem>
                  )}
                  {canAssignLeader && (
                    <DropdownMenuItem onClick={() => setPicker({ role: "group_leader" })}>
                      <UserCogIcon />
                      任命教研组长…
                    </DropdownMenuItem>
                  )}
                  {canAssignExpert && (
                    <DropdownMenuItem onClick={() => setPicker({ role: "city_expert" })}>
                      <UserPlusIcon />
                      任命市级专家…
                    </DropdownMenuItem>
                  )}
                  {revocable.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      {revocable.map((a) => {
                        const path = pathOf(a.node_id) || "?"
                        return (
                          <DropdownMenuItem key={a.id} onClick={() => setRevokeId(a.id)}>
                            <UserRoundXIcon />
                            停用{a.role === "group_leader" ? "组长" : "专家"}任命：{path}
                          </DropdownMenuItem>
                        )
                      })}
                    </>
                  )}
                  {canDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-rose-600 data-open:text-rose-700" onClick={() => setDelOpen(true)}>
                        <Trash2Icon />
                        删除该用户
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </TableCell>
      </TableRow>

      {/* 查看资料：学生账号唯一能做的事（他们不参与审核，可用的操作只剩绑定学校/删除） */}
      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>用户资料</DialogTitle>
            <DialogDescription>{PROFILE_HINTS[u.identity] ?? PROFILE_HINTS.teacher}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <Avatar className="size-12 shrink-0">
              {u.avatar_url && <AvatarImage src={avatarUrl(u.avatar_url)} alt={u.name || ""} />}
              <AvatarFallback className="font-semibold">{initial}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate font-medium">{u.name}</p>
              <p className="truncate text-xs text-muted-foreground">{u.email}</p>
            </div>
          </div>
          <dl className="grid gap-2 text-sm">
            {[
              ["学校", schoolOf(schoolMap, u.school_id) ?? "未绑定"],
              ["身份", identityLabel(u)],
              ["注册时间", u.created_at ? fmtDateTime24(u.created_at) : "—"],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="truncate text-right">{value}</dd>
              </div>
            ))}
          </dl>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProfileOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 绑定学校对话框 */}
      <Dialog open={bindOpen} onOpenChange={setBindOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{u.school_id ? "更换绑定学校" : "绑定学校"}</DialogTitle>
            <DialogDescription>
              用户「{u.name}」将属于所选学校，其教研组长任命以该校名义生效。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Label htmlFor="bind-school">学校</Label>
            {/* 空值用 null 不用 undefined：undefined 会被当成非受控（同 register-form） */}
            <Select value={bindSchool || u.school_id || null} onValueChange={setBindSchool}>
              <SelectTrigger id="bind-school">
                <SelectValue placeholder="选择学校" />
              </SelectTrigger>
              <SelectContent>
                {activeSchools.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button onClick={doBind} disabled={bindBusy}>
              {bindBusy && <Loader2Icon className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 学校管理员任命/撤销确认 */}
      <AlertDialog open={saConfirm} onOpenChange={setSaConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isSchoolAdminNow ? "撤销" : "任命"}「{u.name}」为学校管理员？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isSchoolAdminNow
                ? "撤销后该用户不再管理本校（其已任命的教研组长不受影响，但不能再任命/停用）。"
                : "学校管理员可管理本校用户并任命教研组长（需该用户已绑定学校）。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={saBusy}
              onClick={(e) => {
                e.preventDefault()
                doToggleSA()
              }}
            >
              {saBusy && <Loader2Icon className="size-4 animate-spin" />}
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除用户确认（系统管理员全校；学校管理员仅本校教师；专家与校级管理员无此入口） */}
      <AlertDialog open={delOpen} onOpenChange={(v) => !v && !delBusy && setDelOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除用户「{u.name}」？</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap">
              该操作不可恢复：账号、档案、学校管理员/组长/专家身份将一并删除（级联）。
              {u.school_id ? "其出过的题目不受影响（作者显示「已注销」）。" : "该用户未绑定学校。"}
              其名下在途审批任务的处理人会置空并转为「待指派」，可在审批记录中重新指派。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={delBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={delBusy}
              onClick={(e) => {
                e.preventDefault()
                doDelete()
              }}
            >
              {delBusy && <Loader2Icon className="size-4 animate-spin" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 任命停用确认 */}
      <AlertDialog open={Boolean(revokeId)} onOpenChange={(v) => !v && setRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停用该任命？</AlertDialogTitle>
            <AlertDialogDescription>
              一岗一人：停用后该岗位空缺，此后提交到该节点的题目将无法流转，需要重新任命。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={revokeBusy}
              onClick={(e) => {
                e.preventDefault()
                doRevoke()
              }}
            >
              {revokeBusy && <Loader2Icon className="size-4 animate-spin" />}
              确认停用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 任命节点选择（组长/专家） */}
      <TreePicker
        open={Boolean(picker)}
        onOpenChange={(v) => !v && !busyAction && setPicker(null)}
        nodes={nodes}
        title={picker?.role === "group_leader" ? "任命教研组长 · 选择科目节点" : "任命市级专家 · 选择科目节点"}
        hint={
          picker?.role === "group_leader"
            ? `将任命「${u.name}」为 ${schoolOf(schoolMap, u.school_id) ?? ""} 的教研组长：覆盖所选节点及其后代科目的题目审核（最深处任命优先）。`
            : `将任命「${u.name}」为市级专家：审核所选节点及其后代科目的题目（最深处任命优先）。`
        }
        onSelect={handleNodePick}
      />

      {/* 任教专业选择。选专业大类 = 管该大类下全部专业的学生；选专业 = 只管该专业。 */}
      <TreePicker
        open={majorOpen}
        onOpenChange={(v) => !v && !busyAction && setMajorOpen(false)}
        nodes={nodes}
        title="设置任教专业"
        hint={`决定「${u.name}」在学生名册里能看到哪些学生。选专业大类则覆盖其下全部专业；留空（不设置）则看不到任何学生。`}
        pickable={(n) => n.scope === "vocational" && (n.kind === "category" || n.kind === "major")}
        blockedLabel="（不可选）"
        onSelect={handleNodePick}
      />
    </>
  )
}
