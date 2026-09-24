"use client"

// 班级的增改停用。与 schools-manager / tree-manager 同形：浏览器端直接调 RPC，成功后 router.refresh()
// 让服务端重查（不在这里维护一份本地副本 —— 班级的权威副本在服务端）。
//
// 批量归班**不在这里**：那是「学生名册」上的操作（/students?unassigned=1 选中若干人 → 分配到班级），
// 复用同一张名册表，不必在这个页面再写一套选人 UI。
import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { gradeLabel } from "@/lib/students"
import { nodePathOf } from "@/lib/subject-nodes"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyState } from "@/components/empty-state"
import { TreePicker } from "@/components/admin/tree-picker"
import { Loader2Icon, PlusIcon, UsersRoundIcon } from "lucide-react"

// 班级只能挂 专业大类(category) 或 专业(major)——与 0063 的 validate_class 同一口径
const isMajorNode = (n) => n.scope === "vocational" && (n.kind === "category" || n.kind === "major")

export function ClassesManager({ classes, schools, nodes, caller }) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null)
  const [toggling, setToggling] = useState(null)
  const [busy, setBusy] = useState(false)

  const schoolMap = useMemo(() => new Map((schools ?? []).map((s) => [s.id, s.name])), [schools])
  const activeSchools = useMemo(
    () => (schools ?? []).filter((s) => s.is_active),
    [schools]
  )
  // 系统管理员要按学校分组看；学校管理员只有一所
  const groups = useMemo(() => {
    const by = new Map()
    for (const c of classes ?? []) {
      const key = c.school_id ?? "__mine__"
      if (!by.has(key)) by.set(key, [])
      by.get(key).push(c)
    }
    return [...by.entries()]
  }, [classes])

  async function run(fn, okMsg) {
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = await fn(supabase)
      if (error) throw error
      toast.success(okMsg)
      setCreating(false)
      setEditing(null)
      setToggling(null)
      router.refresh()
    } catch (e) {
      toast.error(e?.message ?? "操作失败")
    } finally {
      setBusy(false)
    }
  }

  const totalStudents = (classes ?? []).reduce((n, c) => n + Number(c.student_count || 0), 0)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => setCreating(true)} disabled={nodes.length === 0}>
          <PlusIcon className="size-4" /> 新建班级
        </Button>
        <span className="text-sm text-muted-foreground">
          共 {classes.length} 个班级 · {totalStudents} 名学生
        </span>
        <Link
          href="/students?unassigned=1"
          className="ml-auto text-sm text-primary underline-offset-2 hover:underline"
        >
          查看未分班学生 →
        </Link>
      </div>

      {classes.length === 0 ? (
        <EmptyState
          icon={UsersRoundIcon}
          title="还没有班级"
          description={
            nodes.length === 0
              ? "专业目录还是空的，请先让系统管理员在「科目树维护」里建立专业大类与专业，再回来建班。"
              : "建好班级后，学生注册时就能选到自己的班级，专业大类与专业会由班级自动带出。"
          }
        />
      ) : (
        groups.map(([schoolId, list]) => (
          <div key={schoolId} className="space-y-2">
            {caller.isAdmin && (
              <h3 className="text-sm font-medium text-muted-foreground">
                {schoolMap.get(schoolId) ?? "（学校已删除）"}
              </h3>
            )}
            <div className="overflow-x-auto rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>班级</TableHead>
                    <TableHead>所属专业</TableHead>
                    <TableHead>入学年份</TableHead>
                    <TableHead>学生数</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((c) => (
                    <TableRow key={c.class_id}>
                      <TableCell className="font-medium">{c.class_name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {nodePathOf(nodes, c.major_node_id) || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {gradeLabel(c.enroll_year) ?? "—"}
                      </TableCell>
                      <TableCell>
                        {Number(c.student_count) > 0 ? (
                          <Link
                            href={`/students?class=${c.class_id}`}
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            {c.student_count} 人
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">0 人</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={c.is_active ? "secondary" : "outline"}>
                          {c.is_active ? "启用中" : "已停用"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {/* 建完班顺手能点进去看这个班的学情（教师端的主入口在名册页） */}
                        <Button
                          size="sm"
                          variant="ghost"
                          nativeButton={false}
                          render={<Link href={`/classes/${c.class_id}`} />}
                        >
                          学情
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setToggling(c)}
                          disabled={busy}
                        >
                          {c.is_active ? "停用" : "启用"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ))
      )}

      {creating && (
        <ClassDialog
          title="新建班级"
          description="班级绑定一个专业大类或专业；学生的专业大类与专业由班级带出。"
          nodes={nodes}
          schools={activeSchools}
          caller={caller}
          busy={busy}
          onCancel={() => setCreating(false)}
          onConfirm={(payload) =>
            run(
              (supabase) => supabase.rpc("admin_create_class", payload),
              "班级已创建"
            )
          }
        />
      )}

      {editing && (
        <ClassDialog
          title={`编辑班级 · ${editing.class_name}`}
          description="改动会同步刷新该班学生档案上的班级名与专业镜像。"
          nodes={nodes}
          schools={activeSchools}
          caller={caller}
          initial={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onConfirm={(payload) =>
            run(
              (supabase) =>
                supabase.rpc("admin_update_class", {
                  p_class_id: editing.class_id,
                  p_name: payload.p_name,
                  p_enroll_year: payload.p_enroll_year,
                  p_major_node_id: payload.p_major_node_id,
                }),
              "班级已更新"
            )
          }
        />
      )}

      {toggling && (
        <AlertDialog open onOpenChange={(o) => !o && setToggling(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {toggling.is_active ? "停用" : "启用"}班级「{toggling.class_name}」？
              </AlertDialogTitle>
              <AlertDialogDescription>
                {toggling.is_active
                  ? "停用后学生仍在册，你仍能在名册里看到他们，只是这个班不会再出现在学生注册与归班的下拉里。"
                  : "启用后该班重新出现在学生注册与归班的下拉里。注意同名班级不能同时启用。"}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={() =>
                  run(
                    (supabase) =>
                      supabase.rpc("admin_set_class_active", {
                        p_class_id: toggling.class_id,
                        p_is_active: !toggling.is_active,
                      }),
                    toggling.is_active ? "班级已停用" : "班级已启用"
                  )
                }
              >
                {busy && <Loader2Icon className="size-4 animate-spin" />}
                确定
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}

function ClassDialog({
  title,
  description,
  nodes,
  schools,
  caller,
  initial,
  busy,
  onCancel,
  onConfirm,
}) {
  const [schoolId, setSchoolId] = useState(
    initial?.school_id ?? caller.schoolId ?? schools[0]?.id ?? ""
  )
  const [name, setName] = useState(initial?.class_name ?? "")
  const [year, setYear] = useState(initial?.enroll_year ? String(initial.enroll_year) : "")
  const [node, setNode] = useState(
    initial?.major_node_id ? (nodes.find((n) => n.id === initial.major_node_id) ?? null) : null
  )
  const [pickerOpen, setPickerOpen] = useState(false)

  const yearInvalid = year !== "" && !/^(19|20|21)\d{2}$/.test(year)
  // 建班必须有学校；编辑时 RPC 只改名字，学校不可变
  const canSubmit = Boolean(name.trim()) && Boolean(node) && !yearInvalid && Boolean(schoolId) && !busy

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {!initial && caller.isAdmin && (
              <div className="grid gap-2">
                <Label htmlFor="cls-school">学校</Label>
                <select
                  id="cls-school"
                  value={schoolId}
                  onChange={(e) => setSchoolId(e.target.value)}
                  className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                >
                  {schools.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="cls-name">班级名称</Label>
              <Input
                id="cls-name"
                value={name}
                maxLength={30}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：24 级计算机 2 班"
              />
            </div>
            <div className="grid gap-2">
              <Label>所属专业</Label>
              <Button
                type="button"
                variant="outline"
                className="justify-start font-normal"
                onClick={() => setPickerOpen(true)}
              >
                {node ? nodePathOf(nodes, node.id) : "点击选择专业大类或专业…"}
              </Button>
              {initial && Number(initial.student_count) > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  改专业会把该班 {initial.student_count} 名学生的专业一起改掉。
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cls-year">入学年份</Label>
              <Input
                id="cls-year"
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="如 2024，留空表示不填"
              />
              {yearInvalid ? (
                <p className="text-xs text-destructive">需为 2000~2100 之间的四位年份</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  填了之后，学生的「入学年份」也由班级带出。
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onCancel} disabled={busy}>
              取消
            </Button>
            <Button
              disabled={!canSubmit}
              onClick={() =>
                onConfirm({
                  p_school_id: schoolId,
                  p_name: name.trim(),
                  p_major_node_id: node?.id ?? null,
                  p_enroll_year: year === "" ? null : Number(year),
                })
              }
            >
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TreePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        nodes={nodes}
        onSelect={setNode}
        pickable={isMajorNode}
        blockedLabel="（不可选）"
        title="选择专业"
        hint="班级须挂在专业大类或专业上；学生的专业大类与专业由此带出。"
      />
    </>
  )
}
