"use client"

import * as React from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  buildTrees,
  childKinds,
  isAttachable,
  kindLabel,
  scopeLabel,
  KIND_LABELS,
  subjectNodesQuery,
} from "@/lib/subject-nodes"
import {
  GitBranchIcon,
  Loader2Icon,
  PlusIcon,
  PencilIcon,
  SnowflakeIcon,
  Trash2Icon,
  CircleCheckIcon,
} from "lucide-react"

// 以下两个组件必须定义在模块级：放进 TreeManager 内部会因每次渲染都产生新的组件类型，
// 导致整棵子树被卸载重挂（Tooltip 状态、DOM 与焦点全部丢失）。回调一律由 props 传入。

function NodeRow({ entry, depth, onOpenDialog, onFreeze }) {
  const { node, children } = entry
  const childKindsList = childKinds(node.scope, node.kind)
  return (
    <>
      <div
        className="group flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-muted/60"
        style={{ marginLeft: `${depth * 28}px` }}
      >
        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground/60" />
        <span className="truncate font-medium">{node.name}</span>
        <Badge variant="secondary" className="shrink-0 text-xs">
          {kindLabel(node.kind)}
        </Badge>
        {isAttachable(node.kind) && !node.is_frozen && (
          <Badge variant="outline" className="shrink-0 text-xs text-emerald-600">
            可挂题
          </Badge>
        )}
        {node.is_frozen && (
          <Badge variant="destructive" className="shrink-0 text-xs">
            已冻结
          </Badge>
        )}
        {/* group-focus-within：键盘 Tab 到操作按钮时同样可见（原先仅 hover 可见） */}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {childKindsList.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`添加${kindLabel(childKindsList[0])}`}
                    onClick={() => onOpenDialog("create-child", { node })}
                  >
                    <PlusIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipContent>添加{kindLabel(childKindsList[0])}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="重命名"
                  onClick={() => onOpenDialog("rename", { node })}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent>重命名</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={node.is_frozen ? "解冻" : "冻结"}
                  onClick={() => onFreeze(node)}
                >
                  {node.is_frozen ? (
                    <CircleCheckIcon className="size-3.5 text-emerald-600" />
                  ) : (
                    <SnowflakeIcon className="size-3.5" />
                  )}
                </Button>
              }
            />
            <TooltipContent>
              {node.is_frozen ? "解冻（恢复挂新题）" : "冻结（暂停挂新题，仅本节点）"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive"
                  aria-label="删除"
                  onClick={() => onOpenDialog("delete", { node })}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent>删除</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {children.map((c) => (
        <NodeRow
          key={c.node.id}
          entry={c}
          depth={depth + 1}
          onOpenDialog={onOpenDialog}
          onFreeze={onFreeze}
        />
      ))}
    </>
  )
}

// 删除确认单独成一个组件、只在删除时挂载：TreeManager 常挂载时，React Compiler 会把
// handleDelete 的记忆化缓存键提成渲染期求值的 `action.node.id`，action 为 null 就抛
// "Cannot read properties of null (reading 'node')"。挪进只在删除分支挂载的组件后，
// 求值必然发生在 node 非空之后（同 confirm-dialog 顶部那条条件挂载约定）。
function DeleteNodeDialog({ node, onClose, onDeleted }) {
  const [busy, setBusy] = React.useState(false)

  async function handleDelete() {
    setBusy(true)
    const { error } = await createClient().rpc("admin_delete_node", {
      p_node_id: node.id,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("节点已删除")
    onDeleted()
    onClose()
  }

  return (
    <ConfirmDialog
      title={`删除「${node.name}」？`}
      description="仅当节点下没有子节点、题目与任命时才允许删除；否则建议「冻结」。删除不可恢复。"
      confirmText="确认删除"
      destructive
      busy={busy}
      onConfirm={handleDelete}
      onClose={onClose}
    />
  )
}

function ScopePane({ scope, trees, onOpenDialog, onFreeze }) {
  const list = trees[scope]
  const rootKind = scope === "common" ? KIND_LABELS.discipline : KIND_LABELS.category
  return (
    <div className="rounded-xl border">
      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-14 text-center">
          <GitBranchIcon className="size-10 text-muted-foreground/50" />
          <div className="space-y-1">
            <p className="font-medium">{scopeLabel(scope)}为空</p>
            <p className="text-sm text-muted-foreground">
              先创建根{rootKind}，再在节点上逐级添加子节点
            </p>
          </div>
          <Button onClick={() => onOpenDialog("create-root", { scope })}>
            <PlusIcon /> 创建{rootKind}
          </Button>
        </div>
      ) : (
        <div className="p-2">
          <div className="mb-2 flex items-center justify-between px-2 pt-1">
            <p className="text-sm font-medium">
              {scopeLabel(scope)}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {countNodes(list)} 个节点
              </span>
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenDialog("create-root", { scope })}
            >
              <PlusIcon className="size-4" /> 新建{rootKind}
            </Button>
          </div>
          {list.map((t) => (
            <NodeRow
              key={t.node.id}
              entry={t}
              depth={0}
              onOpenDialog={onOpenDialog}
              onFreeze={onFreeze}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function TreeManager({ nodes }) {
  // 数据自管理：初始值由服务端传入（SSR 首屏），每次操作成功后用浏览器端
  // 客户端重查全量节点刷新本地状态——不依赖 router.refresh，保证立即显示。
  const [list, setList] = React.useState(nodes)
  const [busy, setBusy] = React.useState(false)
  const trees = React.useMemo(() => buildTrees(list), [list])
  const hasAny = list.length > 0

  // 动作：{ type, node?, scope?, name?, value }
  const [action, setAction] = React.useState(null)
  const [name, setName] = React.useState("")

  async function refreshList() {
    const { data } = await subjectNodesQuery(createClient(), { sorted: true })
    if (data) setList(data)
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

  async function handleSubmit() {
    const a = action
    if (!a) return
    const v = name.trim()
    if (!v) return
    let ok = false
    if (a.type === "create-root") {
      const kind = a.scope === "common" ? "discipline" : "category"
      ok = await run(
        "admin_create_subject_node",
        { p_scope: a.scope, p_kind: kind, p_parent_id: null, p_name: v, p_sort_order: 0 },
        "节点已创建"
      )
    } else if (a.type === "create-child") {
      const kinds = childKinds(a.node.scope, a.node.kind)
      ok = await run(
        "admin_create_subject_node",
        { p_scope: a.node.scope, p_kind: kinds[0], p_parent_id: a.node.id, p_name: v, p_sort_order: 0 },
        "子节点已创建"
      )
    } else if (a.type === "rename") {
      ok = await run("admin_rename_node", { p_node_id: a.node.id, p_name: v }, "已重命名")
    }
    if (ok) setAction(null)
  }

  async function handleFreeze(node) {
    await run(
      "admin_set_node_frozen",
      { p_node_id: node.id, p_frozen: !node.is_frozen },
      node.is_frozen ? "已解冻" : "已冻结"
    )
  }

  function openDialog(type, extra = {}) {
    setName("")
    setAction({ type, ...extra })
  }

  const actionTitle = (() => {
    if (!action) return ""
    switch (action.type) {
      case "create-root":
        return `创建${scopeLabel(action.scope)}根${action.scope === "common" ? "学科" : "大类"}`
      case "create-child":
        return `在「${action.node.name}」下添加${kindLabel(childKinds(action.node.scope, action.node.kind)[0])}`
      case "rename":
        return `重命名「${action.node.name}」`
      default:
        return ""
    }
  })()

  return (
    <div className="space-y-4">
      {!hasAny && (
        <div className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
          树是空的：请先创建公共科目（语文、数学…）与专业目录（大类 → 专业 → 课程）的根节点。
        </div>
      )}
      <Tabs defaultValue="common">
        <TabsList>
          <TabsTrigger value="common">公共科目</TabsTrigger>
          <TabsTrigger value="vocational">专业目录</TabsTrigger>
        </TabsList>
        <TabsContent value="common" className="mt-2">
          <ScopePane
            scope="common"
            trees={trees}
            onOpenDialog={openDialog}
            onFreeze={handleFreeze}
          />
        </TabsContent>
        <TabsContent value="vocational" className="mt-2">
          <ScopePane
            scope="vocational"
            trees={trees}
            onOpenDialog={openDialog}
            onFreeze={handleFreeze}
          />
        </TabsContent>
      </Tabs>

      {/* 新建/重命名对话框 */}
      <Dialog open={action && action.type !== "delete"} onOpenChange={(v) => !v && !busy && setAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{actionTitle}</DialogTitle>
            <DialogDescription>
              {action?.type === "create-child" &&
                "父级校验自动执行：兄弟节点名称不能重复、层级关系必须正确。"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Label htmlFor="node-name">
              {action?.type === "rename" ? "新名称" : "名称"}
            </Label>
            <Input
              id="node-name"
              maxLength={50}
              placeholder={action?.type === "rename" ? action?.node?.name : "节点名称"}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)} disabled={busy}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={busy || !name.trim()}>
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认：条件挂载 + 独立组件，理由见 DeleteNodeDialog 顶部注释 */}
      {action?.type === "delete" && (
        <DeleteNodeDialog
          node={action.node}
          onClose={() => setAction(null)}
          onDeleted={refreshList}
        />
      )}
    </div>
  )
}

function countNodes(rows) {
  let n = 0
  const walk = (list) => {
    for (const t of list) {
      n++
      walk(t.children)
    }
  }
  walk(rows)
  return n
}
