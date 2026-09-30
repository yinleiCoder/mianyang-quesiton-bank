"use client"

import { useState } from "react"
import Link from "next/link"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fmtDate } from "@/lib/format"
import { SCHOOL_COLUMNS } from "@/lib/admin-tables"
import { PlusIcon, Loader2Icon, Building2Icon, MapPinIcon } from "lucide-react"

// cities 由服务端页面一次性传入（市只在 /admin/cities 里改，本页不会新增市）。
// 含已停用的市：改市下拉要能显示"这所学校当前挂在已停用的市上"，
// 否则 Base UI 的 Select 找不到 label 会回退显示 uuid（见 components/ui/select.jsx）。
export function SchoolsManager({ schools, cities }) {
  // 数据自管理：初始值 SSR，操作成功后浏览器端重查刷新（不依赖 router.refresh）
  const [list, setList] = useState(schools)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [cityId, setCityId] = useState(null) // 建校时选的市；null = 未选（不要用 undefined）
  const [pending, setPending] = useState(null) // 停用/启用的学校 id
  const [toggling, setToggling] = useState(false)
  const [moving, setMoving] = useState(null) // 正在改市的学校
  const [moveCityId, setMoveCityId] = useState(null)
  const [saving, setSaving] = useState(false)

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
      p_city_id: cityId,
    })
    setCreating(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("学校已创建")
    setName("")
    setCode("")
    setCityId(null)
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

  async function handleMove() {
    if (!moving || !moveCityId || moveCityId === moving.city_id) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc("admin_set_school_city", {
      p_school_id: moving.id,
      p_city_id: moveCityId,
    })
    setSaving(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(`「${moving.name}」已改到${cityLabel(cities, moveCityId)}`)
    setMoving(null)
    await refreshList()
  }

  // 没有市就建不了学校（admin_create_school 要求指定市）。先指向建市页，
  // 而不是给一个建不出学校的空表单。
  // 只有"学校也还没有"时才整页替换：万一将来市被清空，学校列表不该跟着看不见。
  if (cities.length === 0 && list.length === 0) {
    return (
      <EmptyState
        icon={MapPinIcon}
        title="先建市，再建学校"
        description="每所学校都要挂在市下面（教师、题目、试卷的市由学校推导）。现在一个市都还没有。"
        className="gap-4"
        action={
          <Button nativeButton={false} render={<Link href="/admin/cities" />}>
            <MapPinIcon /> 去创建市
          </Button>
        }
      />
    )
  }

  if (list.length === 0) {
    return (
      <EmptyState
        icon={Building2Icon}
        title="还没有学校"
        description="建库第一步：创建第一所学校（如 XX 职业技术学校），教师注册时即可选择。"
        className="gap-4"
        action={
          <CreateDialog
            name={name} setName={setName} code={code} setCode={setCode}
            cityId={cityId} setCityId={setCityId} cities={cities}
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
          cityId={cityId} setCityId={setCityId} cities={cities}
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
              <TableHead>所属市</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="w-40 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {s.code}
                </TableCell>
                <TableCell className="text-sm">
                  {s.cities?.name ?? <span className="text-destructive">未挂市</span>}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMoving(s)
                      setMoveCityId(s.city_id)
                    }}
                  >
                    <MapPinIcon className="size-3.5" /> 改市
                  </Button>
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

      {/* 改市：一步到位的整体迁移，确认框里如实讲清后果 */}
      <Dialog open={Boolean(moving)} onOpenChange={(v) => !v && !saving && setMoving(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>「{moving?.name}」改到哪个市？</DialogTitle>
            <DialogDescription>
              市是推导出来的：改完这一步，该校的教师、题目、试卷、班级当场全部归到新市，
              不存在「一半还在旧市」。历史审批记录不重算，留在原市的审批池里。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Label htmlFor="move-city">所属市</Label>
            <Select value={moveCityId} onValueChange={setMoveCityId}>
              <SelectTrigger id="move-city">
                <SelectValue placeholder="选择市" />
              </SelectTrigger>
              <SelectContent>
                {cities.map((c) => (
                  <SelectItem key={c.id} value={c.id} disabled={!c.is_active}>
                    {c.name}{c.is_active ? "" : "（已停用）"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoving(null)} disabled={saving}>
              取消
            </Button>
            <Button
              onClick={handleMove}
              disabled={saving || !moveCityId || moveCityId === moving?.city_id}
            >
              {saving && <Loader2Icon className="size-4 animate-spin" />}
              确认改市
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function cityLabel(cities, id) {
  return cities.find((c) => c.id === id)?.name ?? "新市"
}

function CreateDialog({ name, setName, code, setCode, cityId, setCityId, cities, creating, onSubmit, trigger }) {
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
                placeholder="XX 职业技术学校"
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
            <div className="grid gap-2">
              <Label htmlFor="school-city">所属市</Label>
              {cities.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  还没有市。先去
                  <Link href="/admin/cities" className="text-foreground underline">
                    「市管理」
                  </Link>
                  创建一个（如 绵阳市）。
                </p>
              ) : (
                <Select value={cityId} onValueChange={setCityId}>
                  <SelectTrigger id="school-city">
                    <SelectValue placeholder="选择市" />
                  </SelectTrigger>
                  <SelectContent>
                    {cities.map((c) => (
                      <SelectItem key={c.id} value={c.id} disabled={!c.is_active}>
                        {c.name}{c.is_active ? "" : "（已停用）"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                该校教师、题目、试卷的市都由这里推导，建成后再改要整校迁移。
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={creating || !cityId}>
              {creating && <Loader2Icon className="size-4 animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
