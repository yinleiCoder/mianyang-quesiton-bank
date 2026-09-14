"use client"

import * as React from "react"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TAG_COLUMNS } from "@/lib/admin-tables"
import { Loader2Icon, MergeIcon, PencilIcon, TagsIcon } from "lucide-react"

// 打标引用数在 version_tags 上聚合（PostgREST 内嵌计数），统一归一为 usage。
// 列清单放在 lib/admin-tables.js：服务端页面也要用，从 "use client" 模块导出会被
// 包成 client reference 代理对象（见该文件注释）。
const normalizeTag = (row) => ({ ...row, usage: row.version_tags?.[0]?.count ?? 0 })

export function TagsManager({ tags: initialTags }) {
  // 数据自管理：初始值 SSR，操作成功后浏览器端重查（不依赖 router.refresh）
  const [tags, setTags] = React.useState(() => initialTags.map(normalizeTag))
  const [busy, setBusy] = React.useState(false)
  const [renameTag, setRenameTag] = React.useState(null)
  const [renameValue, setRenameValue] = React.useState("")
  const [mergeTag, setMergeTag] = React.useState(null)
  const [mergeTarget, setMergeTarget] = React.useState("")

  async function refreshList() {
    const supabase = createClient()
    const { data } = await supabase.from("tags").select(TAG_COLUMNS).order("name")
    if (data) setTags(data.map(normalizeTag))
  }

  async function run(fn, params, msg) {
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.rpc(fn, params)
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return false
    }
    toast.success(msg)
    await refreshList()
    return true
  }

  async function doRename() {
    const v = renameValue.trim()
    if (!v || !renameTag) return
    const ok = await run(
      "admin_rename_tag",
      { p_tag_id: renameTag.id, p_new_name: v },
      "标签已重命名"
    )
    if (ok) setRenameTag(null)
  }

  async function doMerge() {
    if (!mergeTag || !mergeTarget || mergeTarget === mergeTag.id) return
    const ok = await run(
      "admin_merge_tag",
      { p_from_tag: mergeTag.id, p_to_tag: mergeTarget },
      "标签已合并"
    )
    if (ok) {
      setMergeTag(null)
      setMergeTarget("")
    }
  }

  if (tags.length === 0) {
    return (
      <EmptyState
        icon={TagsIcon}
        title="暂无标签"
        description="教师在出题时可以自由创建知识点标签（如「安全用电」「钳工基础」）；题库运行一段时间后可在此重命名规范、把同义标签合并。"
      />
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">共 {tags.length} 个标签</p>
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>标签名</TableHead>
              <TableHead className="w-28 text-center">引用次数</TableHead>
              <TableHead className="w-28 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tags.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {t.name}
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      {t.usage} 题
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="text-center text-muted-foreground">
                  {t.usage}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRenameTag(t)
                      setRenameValue(t.name)
                    }}
                  >
                    <PencilIcon className="size-3.5" /> 重命名
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={tags.length < 2}
                    onClick={() => {
                      setMergeTag(t)
                      setMergeTarget("")
                    }}
                  >
                    <MergeIcon className="size-3.5" /> 合并…
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* 重命名 */}
      <Dialog open={Boolean(renameTag)} onOpenChange={(v) => !v && !busy && setRenameTag(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名标签</DialogTitle>
            <DialogDescription>
              「{renameTag?.name}」将被改名为输入值（已有同名校验）。历史题目显示旧名称快照，不受影响。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Label htmlFor="tag-name">标签名</Label>
            <Input
              id="tag-name"
              maxLength={30}
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doRename()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTag(null)} disabled={busy}>
              取消
            </Button>
            <Button onClick={doRename} disabled={busy || !renameValue.trim()}>
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 合并确认 */}
      <AlertDialog open={Boolean(mergeTag)} onOpenChange={(v) => !v && !busy && setMergeTag(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              合并「{mergeTag?.name}」到目标标签？
            </AlertDialogTitle>
            <AlertDialogDescription>
              该标签的全部引用会转到目标标签；若目标为空引用，本标签将被删除。不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-3 py-2">
            <Label htmlFor="merge-target">合并到</Label>
            {/* 空值用 null 不用 undefined：undefined 会被当成非受控（同 register-form） */}
            <Select value={mergeTarget || null} onValueChange={setMergeTarget}>
              <SelectTrigger id="merge-target">
                <SelectValue placeholder="选择目标标签" />
              </SelectTrigger>
              <SelectContent>
                {tags
                  .filter((t) => t.id !== mergeTag?.id)
                  .map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}（{t.usage} 题）
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !mergeTarget || mergeTarget === mergeTag?.id}
              onClick={(e) => {
                e.preventDefault()
                doMerge()
              }}
            >
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              确认合并
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
