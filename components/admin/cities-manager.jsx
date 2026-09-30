"use client"

import { useState } from "react"
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
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { fmtDate } from "@/lib/format"
import { CITY_COLUMNS } from "@/lib/admin-tables"
import { PlusIcon, Loader2Icon, MapPinIcon } from "lucide-react"

// 学校数在 schools 上聚合（PostgREST 内嵌计数），统一归一为 schools。
// 列清单放 lib/admin-tables.js：服务端页面也要用（同 tags-manager 的理由）。
const normalizeCity = (row) => ({ ...row, schools: row.schools?.[0]?.count ?? 0 })

export function CitiesManager({ cities: initialCities }) {
  // 数据自管理：初始值 SSR，操作成功后浏览器端重查刷新（不依赖 router.refresh）
  const [list, setList] = useState(() => initialCities.map(normalizeCity))
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [pending, setPending] = useState(null) // 停用/启用的市 id
  const [toggling, setToggling] = useState(false)

  async function refreshList() {
    const supabase = createClient()
    const { data } = await supabase.from("cities").select(CITY_COLUMNS).order("name")
    if (data) setList(data.map(normalizeCity))
  }

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    const supabase = createClient()
    const { error } = await supabase.rpc("admin_create_city", {
      p_name: name.trim(),
      p_code: code.trim(),
    })
    setCreating(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("市已创建")
    setName("")
    setCode("")
    await refreshList()
  }

  async function handleToggle(city) {
    setToggling(true)
    const supabase = createClient()
    const { error } = await supabase.rpc("admin_set_city_active", {
      p_city_id: city.id,
      p_active: !city.is_active,
    })
    setToggling(false)
    setPending(null)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(city.is_active ? "已停用" : "已启用")
    await refreshList()
  }

  if (list.length === 0) {
    return (
      <EmptyState
        icon={MapPinIcon}
        title="还没有市"
        description="多选题库第一步：先建市（如 绵阳市、南充市），再把学校挂到市上。建市之后才能建学校。"
        className="gap-4"
        action={
          <CreateDialog
            name={name} setName={setName} code={code} setCode={setCode}
            creating={creating} onSubmit={handleCreate}
            trigger={
              <Button>
                <PlusIcon /> 创建市
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
        <p className="text-sm text-muted-foreground">共 {list.length} 个市</p>
        <CreateDialog
          name={name} setName={setName} code={code} setCode={setCode}
          creating={creating} onSubmit={handleCreate}
          trigger={
            <Button>
              <PlusIcon /> 创建市
            </Button>
          }
        />
      </div>
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>市名称</TableHead>
              <TableHead>代码</TableHead>
              <TableHead className="w-24 text-center">学校数</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {c.code}
                </TableCell>
                <TableCell className="text-center text-muted-foreground">
                  {c.schools}
                </TableCell>
                <TableCell>
                  <Badge variant={c.is_active ? "default" : "secondary"}>
                    {c.is_active ? "启用中" : "已停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {fmtDate(c.created_at)}
                </TableCell>
                <TableCell className="text-right">
                  <AlertDialog
                    open={pending === c.id}
                    onOpenChange={(v) => !v && setPending(null)}
                  >
                    <AlertDialogTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPending(c.id)}
                        >
                          {c.is_active ? "停用" : "启用"}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {c.is_active ? "停用" : "启用"}「{c.name}」？
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {c.is_active
                            ? c.schools > 0
                              ? `停用后不能再往这个市建新学校；已挂在这里的 ${c.schools} 所学校不受影响，要迁走需在「学校管理」里逐个改市。`
                              : "停用后不能再往这个市建新学校。"
                            : "启用后恢复：可以在这个市下建学校。"}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel disabled={toggling}>取消</AlertDialogCancel>
                        <AlertDialogAction
                          disabled={toggling}
                          onClick={(e) => {
                            e.preventDefault()
                            handleToggle(c)
                          }}
                        >
                          {toggling && <Loader2Icon className="size-4 animate-spin" />}
                          确认{c.is_active ? "停用" : "启用"}
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
            <DialogTitle>创建市</DialogTitle>
            <DialogDescription>
              市代码用于唯一标识（如 MY、NC），展示时转大写。市与市名都不能和已有的重复。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="city-name">市名称</Label>
              <Input
                id="city-name"
                required
                maxLength={50}
                placeholder="绵阳市"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="city-code">代码</Label>
              <Input
                id="city-code"
                required
                maxLength={20}
                placeholder="MY"
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
