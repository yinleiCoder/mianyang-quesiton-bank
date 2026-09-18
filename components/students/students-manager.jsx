"use client"

// 学生名册表格 + 筛选 + 归班。数据由服务端页面取好传进来（SSR seed），
// 改完数据用 router.refresh() 让服务端重查 —— 比在客户端重跑一遍 RPC 更简单，
// 也保证了"筛选口径"只有服务端一处（与 users-manager.jsx 的浏览器端重查是两种取法，
// 那边要重查的字典太多，这边只有一张表）。
//
// 筛选一律走 URL：换条件 = 换链接，服务端按新条件重新装配。
import { useMemo, useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { accuracyPercent, gradeLabel, studentQueryString } from "@/lib/students"
import { fmtDateTime24 } from "@/lib/format"
import { avatarUrl } from "@/lib/oss-url"
import { displayIdentifier } from "@/lib/phone"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { EmptyState } from "@/components/empty-state"
import { Loader2Icon, SearchIcon, UserRoundPenIcon, GraduationCapIcon } from "lucide-react"

export function StudentsManager({ rows, classes, schools, filters, caller, hasFilters, total }) {
  const router = useRouter()
  const pathname = usePathname() ?? "/students"
  const [kw, setKw] = useState(filters.kw ?? "")
  const [selected, setSelected] = useState(() => new Set())
  const [assignOpen, setAssignOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)

  const schoolMap = useMemo(() => new Map((schools ?? []).map((s) => [s.id, s.name])), [schools])
  // 班级字段名以 list_my_student_classes 的返回列为准（class_id / class_name），
  // 不是 classes 表的 id / name —— 两套名字混用会让下拉全是空选项（0063 的 RPC 列名）
  const classMap = useMemo(() => new Map((classes ?? []).map((c) => [c.class_id, c])), [classes])
  // 只有能建班的角色能改班级；教师是只读的（SQL 里 admin_* RPC 也会再挡一次，UI 不是边界）
  const canManage = caller.isAdmin || caller.isSchoolAdmin
  // 可选班级限定在能管理的那所学校：系统管理员要按行上的学校分别筛
  const assignableClasses = useMemo(
    () => (classes ?? []).filter((c) => c.is_active),
    [classes]
  )

  const selectedClass = filters.classId ? classMap.get(filters.classId) : null

  // 换筛选条件一律回到第一页：留在第 3 页去看一个只有 5 条结果的筛选，只会得到空列表
  function go(patch) {
    const qs = studentQueryString({ ...filters, ...patch }, 1)
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.user_id))
  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.user_id)))
  }
  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function runRpc(fn, okMsg) {
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = await fn(supabase)
      if (error) throw error
      toast.success(okMsg)
      setSelected(new Set())
      setAssignOpen(false)
      setEditing(null)
      router.refresh()
    } catch (e) {
      toast.error(e?.message ?? "操作失败")
    } finally {
      setBusy(false)
    }
  }

  function submitAssign(classId) {
    const ids = [...selected]
    runRpc(
      (supabase) => supabase.rpc("admin_bulk_assign_class", { p_user_ids: ids, p_class_id: classId }),
      `已把 ${ids.length} 名学生归入班级`
    )
  }

  const classRollup = selectedClass ? classSummary(selectedClass) : null

  return (
    <div className="space-y-3">
      {/* 筛选条：与 bank-filters 同构 —— 每个筛选项 flex-col，标签在上控件在下 */}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          go({ kw: kw.trim() })
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">姓名 / 邮箱</span>
          <span className="relative block">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="搜索学生…"
              className="h-9 w-56 pl-8"
            />
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">班级</span>
          <select
            value={filters.onlyUnassigned ? "__unassigned__" : (filters.classId ?? "")}
            onChange={(e) => {
              const v = e.target.value
              if (v === "__unassigned__") go({ onlyUnassigned: true, classId: "" })
              else go({ classId: v, onlyUnassigned: false })
            }}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
          >
            <option value="">全部班级</option>
            {(classes ?? []).map((c) => (
              <option key={c.class_id} value={c.class_id}>
                {c.class_name}
                {c.is_active ? "" : "（已停用）"} · {c.student_count} 人
              </option>
            ))}
            <option value="__unassigned__">未分班</option>
          </select>
        </label>

        {hasFilters && (
          <Button type="button" variant="ghost" size="sm" onClick={() => router.push(pathname)}>
            清除筛选
          </Button>
        )}
        <span className="ml-auto self-center text-sm text-muted-foreground">
          共 <span className="font-medium text-foreground">{total.toLocaleString("zh-CN")}</span> 名学生
          {hasFilters && "（已按筛选条件过滤）"}
        </span>
      </form>

      {/* 班级概览：选中某个班时，先给一行汇总，下面才是逐人明细 —— 这就是"以班级为单位查看" */}
      {selectedClass && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border bg-card px-4 py-3 text-sm">
          <span className="font-medium">{selectedClass.class_name}</span>
          {!selectedClass.is_active && <Badge variant="outline">已停用</Badge>}
          {selectedClass.enroll_year && (
            <span className="text-muted-foreground">{gradeLabel(selectedClass.enroll_year)}</span>
          )}
          <span className="text-muted-foreground">{selectedClass.student_count} 人</span>
          <span className="text-muted-foreground">
            班级正确率 {classRollup.accuracy ?? "—"}
            <span className="ml-1 text-xs text-muted-foreground/70">
              （客观题 {selectedClass.graded_count} 次作答）
            </span>
          </span>
          <span className="text-muted-foreground">
            最近练习 {fmtDateTime24(selectedClass.last_practiced_at) || "暂无"}
          </span>
        </div>
      )}

      {/* 批量归班条：只在选了人、且有权限时出现 */}
      {canManage && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm">
          <span>已选 {selected.size} 名学生</span>
          <Button size="sm" onClick={() => setAssignOpen(true)}>
            批量分配到班级…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={GraduationCapIcon}
          title={hasFilters ? "没有符合条件的学生" : "还没有学生"}
          description={
            hasFilters
              ? "换个班级或关键词再试，或清除筛选查看全部。"
              : "学生通过客户端注册后会出现在这里。"
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                {canManage && (
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={toggleAll}
                      aria-label="全选本页"
                      className="size-4 accent-primary"
                    />
                  </TableHead>
                )}
                <TableHead>学生</TableHead>
                <TableHead>班级</TableHead>
                <TableHead>入学年份</TableHead>
                <TableHead>专业大类</TableHead>
                <TableHead>专业</TableHead>
                {caller.isAdmin && <TableHead>学校</TableHead>}
                <TableHead>练习</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const acc = accuracyPercent(r)
                const initial = (r.name || "?").slice(0, 1)
                return (
                  <TableRow key={r.user_id}>
                    {canManage && (
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selected.has(r.user_id)}
                          onChange={() => toggleOne(r.user_id)}
                          aria-label={`选择 ${r.name}`}
                          className="size-4 accent-primary"
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="size-7 shrink-0 rounded-md">
                          {r.avatar_url && (
                            <AvatarImage src={avatarUrl(r.avatar_url)} alt={r.name ?? ""} />
                          )}
                          <AvatarFallback className="rounded-md text-xs">{initial}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{r.name || "（未填姓名）"}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {displayIdentifier({ phone: r.phone, email: r.email })}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {r.class_id ? (
                        <span className="inline-flex items-center gap-1.5">
                          {r.class_name}
                          {r.class_is_active === false && (
                            <Badge variant="outline" className="px-1 text-xs">
                              已停用
                            </Badge>
                          )}
                        </span>
                      ) : (
                        // 未分班是可操作的待办，不是"空"——点它就能筛出全部待分配的学生
                        <button
                          type="button"
                          onClick={() => go({ onlyUnassigned: true, classId: "" })}
                          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
                        >
                          班级待分配
                          {r.class_name ? `（填的是「${r.class_name}」）` : ""}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {gradeLabel(r.enroll_year) ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.major_category || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{r.major || "—"}</TableCell>
                    {caller.isAdmin && (
                      <TableCell className="text-muted-foreground">
                        {schoolMap.get(r.school_id) ?? "—"}
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="text-sm">{acc ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.session_count > 0
                          ? `${r.session_count} 次 · ${r.answered_count} 答`
                          : "未练习"}
                        {r.last_practiced_at && (
                          <span className="ml-1 text-muted-foreground/70">
                            {fmtDateTime24(r.last_practiced_at)}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          nativeButton={false}
                          render={<Link href={`/students/${r.user_id}`} />}
                        >
                          查看学情
                        </Button>
                        {canManage && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditing(r)}
                            title="修改班级与入学年份"
                          >
                            <UserRoundPenIcon className="size-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {assignOpen && (
        <AssignDialog
          count={selected.size}
          classes={assignableClasses}
          busy={busy}
          onCancel={() => setAssignOpen(false)}
          onConfirm={submitAssign}
        />
      )}
      {editing && (
        <StudentEditDialog
          student={editing}
          classes={assignableClasses}
          busy={busy}
          onCancel={() => setEditing(null)}
          onConfirm={(enrollYear, classId) =>
            runRpc(
              (supabase) =>
                supabase.rpc("admin_update_student", {
                  p_user_id: editing.user_id,
                  p_enroll_year: enrollYear,
                  p_class_id: classId,
                }),
              "已更新学生学籍"
            )
          }
        />
      )}
    </div>
  )
}

function classSummary(c) {
  const g = Number(c.graded_count) || 0
  return { accuracy: g > 0 ? `${Math.round(((Number(c.correct_count) || 0) / g) * 100)}%` : null }
}

function AssignDialog({ count, classes, busy, onCancel, onConfirm }) {
  const [classId, setClassId] = useState("")
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>批量分配班级</DialogTitle>
          <DialogDescription>
            把选中的 {count} 名学生归入同一个班级。学生的专业大类与专业会随之由班级带出。
          </DialogDescription>
        </DialogHeader>
        {classes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有可用班级，请先到「班级管理」建立班级。
          </p>
        ) : (
          <div className="grid gap-2">
            <Label>目标班级</Label>
            <select
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
            >
              <option value="">请选择…</option>
              {classes.map((c) => (
                <option key={c.class_id} value={c.class_id}>
                  {c.class_name}
                </option>
              ))}
            </select>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button disabled={!classId || busy} onClick={() => onConfirm(classId)}>
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            确定分配
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StudentEditDialog({ student, classes, busy, onCancel, onConfirm }) {
  const [classId, setClassId] = useState(student.class_id ?? "")
  const [year, setYear] = useState(student.enroll_year ? String(student.enroll_year) : "")
  const yearInvalid = year !== "" && !/^(19|20|21)\d{2}$/.test(year)

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改学籍 · {student.name}</DialogTitle>
          <DialogDescription>
            选择班级后，专业大类与专业由班级带出；选择「未分班」会清空这些字段。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="stu-class">班级</Label>
            <select
              id="stu-class"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
            >
              <option value="">未分班</option>
              {classes.map((c) => (
                <option key={c.class_id} value={c.class_id}>
                  {c.class_name}
                  {student.class_id === c.class_id ? "（当前）" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="stu-year">入学年份</Label>
            <Input
              id="stu-year"
              inputMode="numeric"
              placeholder="如 2024，留空表示不填"
              value={year}
              onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
            />
            {yearInvalid && (
              <p className="text-xs text-destructive">入学年份需为 2000~2100 之间的四位年份</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            disabled={busy || yearInvalid}
            onClick={() => onConfirm(year === "" ? null : Number(year), classId || null)}
          >
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
