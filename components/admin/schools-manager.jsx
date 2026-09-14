"use client"

import * as React from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
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
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { fmtDate } from "@/lib/format"
import { SCHOOL_COLUMNS } from "@/lib/admin-tables"
import { PlusIcon, Loader2Icon, Building2Icon } from "lucide-react"

export function SchoolsManager({ schools }) {
  // 数据自管理：初始值 SSR，操作成功后浏览器端重查刷新（不依赖 router.refresh）
  const [list, setList] = React.useState(schools)
  const [creating, setCreating] = React.useState(false)
  const [name, setName] = React.useState("")
  const [code, setCode] = React.useState("")
  const [pending, setPending] = React.useState(null) // 停用/启用的学校 id
  const [toggling, setToggling] = React.useState(false)

  async function refreshList() {
    const supabase = createClient()
    const { data } = await supabase.from("schools").select(SCHOOL_COLUMNS).order("name")
    if (data) setList(data)
  }

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    const supabase = createClient()
    const { error } = await supabase.rpc("admin_create_school", {
      p_name: name.trim(),
      p_code: code.trim(),
    })
    setCreating(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("学校已创建")
    setName("")
    setCode("")
    await refreshList()
  }

  async function handleToggle(school) {
    setToggling(true)
    const supabase = createClient()
    const { error } = await supabase.rpc("admin_set_school_active", {
      p_school_id: school.id,
      p_active: !school.is_active,
    })
    setToggling(false)
    setPending(null)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(school.is_active ? "已停用" : "已启用")
    await refreshList()
  }

  if (list.length === 0) {
    return (
      <EmptyState
        icon={Building2Icon}
        title="还没有学校"
        description="建库第一步：创建第一所学校（如 绵阳职业技术学校），教师注册时即可选择。"
        className="gap-4"
        action={
          <CreateDialog
            name={name} setName={setName} code={code} setCode={setCode}
            creating={creating} onSubmit={handleCreate}
            trigger={
              <Button>
                <PlusIcon /> 创建学校
              </Button>
            }
          />
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          共 {list.length} 所学校
        </p>
        <CreateDialog
          name={name} setName={setName} code={code} setCode={setCode}
          creating={creating} onSubmit={handleCreate}
          trigger={
            <Button>
              <PlusIcon /> 创建学校
            </Button>
          }
        />
      </div>
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>学校名称</TableHead>
              <TableHead>代码</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {s.code}
                </TableCell>
                <TableCell>
                  <Badge variant={s.is_active ? "default" : "secondary"}>
                    {s.is_active ? "启用中" : "已停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {fmtDate(s.created_at)}
                </TableCell>
                <TableCell className="text-right">
                  <AlertDialog
                    open={pending === s.id}
                    onOpenChange={(v) => !v && setPending(null)}
                  >
                    <AlertDialogTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPending(s.id)}
                        >
                          {s.is_active ? "停用" : "启用"}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {s.is_active ? "停用" : "启用"}「{s.name}」？
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {s.is_active
                            ? "停用后该校教师无法提交新题、学校管理员无法任命组长；历史题目不受影响。"
                            : "启用后该校恢复参与共建。"}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel disabled={toggling}>取消</AlertDialogCancel>
                        <AlertDialogAction
                          disabled={toggling}
                          onClick={(e) => {
                            e.preventDefault()
                            handleToggle(s)
                          }}
                        >
                          {toggling && <Loader2Icon className="size-4 animate-spin" />}
                          确认{s.is_active ? "停用" : "启用"}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function CreateDialog({ name, setName, code, setCode, creating, onSubmit, trigger }) {
  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>创建学校</DialogTitle>
            <DialogDescription>学校代码用于唯一标识（如 MYSY），展示时转大写。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="school-name">学校名称</Label>
              <Input
                id="school-name"
                required
                maxLength={100}
                placeholder="绵阳职业技术学校"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="school-code">代码</Label>
              <Input
                id="school-code"
                required
                maxLength={20}
                placeholder="MYSY"
                className="font-mono uppercase"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={creating}>
              {creating && <Loader2Icon className="size-4 animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
