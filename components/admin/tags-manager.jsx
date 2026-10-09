"use client"

import { useState } from "react"
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
import { nodePathOf } from "@/lib/subject-nodes"
import { tagIndex } from "@/lib/tag-tree"
import { Loader2Icon, MergeIcon, PencilIcon, TagsIcon, TreePineIcon } from "lucide-react"

// 打标引用数在 version_tags 上聚合（PostgREST 内嵌计数），统一归一为 usage。
// 列清单放在 lib/admin-tables.js：服务端页面也要用，从 "use client" 模块导出会被
// 包成 client reference 代理对象（见该文件注释）。
const normalizeTag = (row) => ({ ...row, usage: row.version_tags?.[0]?.count ?? 0 })

// 「未归类」在下拉里表示"不指派学科"，用哨兵字符串而不是空串——
// 空串在这套 Select 里和"未选择"分不开。
const NO_SUBJECT = "__none__"

export function TagsManager({ tags: initialTags, nodes = [] }) {
  // 数据自管理：初始值 SSR，操作成功后浏览器端重查（不依赖 router.refresh）
  const [tags, setTags] = useState(() => initialTags.map(normalizeTag))
  const [busy, setBusy] = useState(false)
  const [renameTag, setRenameTag] = useState(null)
  const [renameValue, setRenameValue] = useState("")
  const [mergeTag, setMergeTag] = useState(null)
  const [mergeTarget, setMergeTarget] = useState("")
  const [assignTag, setAssignTag] = useState(null)
  const [assignSubject, setAssignSubject] = useState(NO_SUBJECT)
  const [assignParent, setAssignParent] = useState(NO_SUBJECT)

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

  async function doAssign() {
    if (!assignTag) return
    const parent = assignParent === NO_SUBJECT ? null : assignParent
    // 选了父级就由父级决定学科（服务端同此口径）——两处都给会互相打架
    const subject =
      assignParent === NO_SUBJECT
        ? assignSubject === NO_SUBJECT
          ? null
          : assignSubject
        : null
    const ok = await run(
      "admin_move_tag",
      {
        p_tag_id: assignTag.id,
        p_subject_node_id: subject,
        p_new_parent_id: parent,
      },
      parent ? "已挂到父知识点下（含其子知识点）" : subject ? "已指派学科（含其子知识点）" : "已退回未归类"
    )
    if (ok) setAssignTag(null)
  }

  const { ancestorPathOf, descendantIds } = tagIndex(tags)
  // 可选的父知识点：同一学科下、排除自己与自己的后代（成环）。
  // 学科没选（未归类）时只在未归类的里面挑——子与父必须同学科，这是服务端的硬约束。
  const assignSubjectValue = assignSubject === NO_SUBJECT ? null : assignSubject
  const parentCandidates = assignTag
    ? tags.filter(
        (t) =>
          t.id !== assignTag.id &&
          !descendantIds(assignTag.id).has(t.id) &&
          (t.subject_node_id ?? null) === assignSubjectValue
      )
    : []
  const unassigned = tags.filter((t) => !t.subject_node_id).length

  if (tags.length === 0) {
    return (
      <EmptyState
        icon={TagsIcon}
        title="暂无知识点"
        description="教师在出题时可以自由创建知识点（如「安全用电」「钳工基础」）；题库运行一段时间后可在此指派学科、重命名规范、把同义知识点合并。"
      />
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        共 {tags.length} 个知识点
        {unassigned > 0 && (
          <>
            {"，其中 "}
            <span className="font-medium text-foreground">{unassigned} 个未归类</span>
            {"——未归类的不会出现在教师的候选里，先指派学科。"}
          </>
        )}
      </p>
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>知识点</TableHead>
              <TableHead className="w-56">学科</TableHead>
              <TableHead className="w-28 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tags.map((t) => {
              const ancestors = ancestorPathOf(t.id)
              return (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span>
                        {/* 层级：祖先那段单独弱化，一眼看出它在树的哪一层 */}
                        {ancestors && (
                          <span className="text-muted-foreground">{ancestors} / </span>
                        )}
                        {t.name}
                      </span>
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        {t.usage} 题
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    {t.subject_nodes?.name ? (
                      <span className="text-sm">{t.subject_nodes.name}</span>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        未归类
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAssignTag(t)
                        setAssignSubject(t.subject_node_id || NO_SUBJECT)
                        setAssignParent(NO_SUBJECT)
                      }}
                    >
                      <TreePineIcon className="size-3.5" /> 指派…
                    </Button>
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
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* 重命名 */}
      <Dialog open={Boolean(renameTag)} onOpenChange={(v) => !v && !busy && setRenameTag(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名标签</DialogTitle>
            <DialogDescription>
              「{renameTag?.name}」将被改名为输入值（**同一学科同一父级**下不允许重名，
              换到别的学科则不受限）。历史题目显示旧名称快照，不受影响。
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

      {/* 指派学科（0096）：存量里那些学科名/课程名混进来的标签就靠这里归位 */}
      <Dialog open={Boolean(assignTag)} onOpenChange={(v) => !v && !busy && setAssignTag(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>指派「{assignTag?.name}」的学科</DialogTitle>
            <DialogDescription>
              指派后，它（连同它下面的子知识点）只出现在该学科及其子树下的题目里。
              退回「未归类」则教师候选里看不到它。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Label htmlFor="assign-subject">所属学科</Label>
            {/* 空值用 null 不用 undefined：undefined 会被当成非受控（同 register-form） */}
            <Select value={assignSubject || null} onValueChange={setAssignSubject}>
              <SelectTrigger id="assign-subject">
                <SelectValue placeholder="选择学科" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SUBJECT}>未归类（不在任何学科下）</SelectItem>
                {nodes.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {nodePathOf(nodes, n.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label htmlFor="assign-parent">父知识点（可选）</Label>
            <Select value={assignParent || null} onValueChange={setAssignParent}>
              <SelectTrigger id="assign-parent">
                <SelectValue placeholder="作为顶层知识点" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SUBJECT}>顶层（没有父级）</SelectItem>
                {parentCandidates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {ancestorPathOf(t.id) ? `${ancestorPathOf(t.id)} / ${t.name}` : t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              选了父级就由父级决定学科（子与父必须同学科）。「{assignTag?.name}」
              连同它下面的子知识点一起移动。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignTag(null)} disabled={busy}>
              取消
            </Button>
            <Button onClick={doAssign} disabled={busy}>
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
              <br />
              只能合并**同一学科**下的知识点——跨学科合并不报错，但会把两个学科的题混进同一个知识点。
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
                {/* 只列同学科的：服务端 admin_merge_tag 会拒跨学科合并，
                    把不可选项摆出来只会让人点了才被拒 */}
                {tags
                  .filter(
                    (t) =>
                      t.id !== mergeTag?.id &&
                      (t.subject_node_id ?? null) === (mergeTag?.subject_node_id ?? null)
                  )
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
