"use client"

// 科目树的**画布视图**（可拖拽）：把层级画成节点图，拖一个节点到另一个节点上就改挂点。
//
// 为什么值得有：树维护此前只能"建 / 删 / 改名"，**没有搬移** —— 想给一个已有题目的知识点
// 换个上级，只能新建一个再把题目一道道挪过去，实际没人会那么干（见 0089 的头注）。
// 拖拽是这件事最自然的操作方式，而"层级是不是对"用眼睛看比在对话框里读名字快得多。
//
// 三条与列表视图共用同一份真源，别在这里另立一套：
//   · 谁能当谁的父节点 —— lib/subject-nodes.js 的 childKinds（界面按它决定"能不能放"）；
//   · 真正危险的守卫（成环 / 跨目录 / 自己挂自己）在 SQL 里（admin_move_subject_node）；
//   · 数据与刷新 —— nodes 由页面传进来，改完 router.refresh()，不在这里本地改树。
//
// 布局是自己算的（tidy tree：叶子顺次排开、父节点居中于子节点），不引 dagre：
// 需求只是"看上去是一棵树"，为此多一个布局库不值当。

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { createClient } from "@/lib/supabase/client"
import { childKinds, indexNodes, kindLabel, scopeLabel } from "@/lib/subject-nodes"
import { ConfirmDialog } from "@/components/confirm-dialog"

const NODE_W = 188
const NODE_H = 52
const H_GAP = NODE_W + 28
const V_GAP = 104

/** 自定义节点：名字 + 层级；冻结的用虚线框，拖动时不可放的节点变淡。 */
function SubjectNode({ data, selected }) {
  return (
    <div
      className={`w-[188px] rounded-lg border bg-background px-3 py-2 shadow-sm transition-opacity ${
        selected ? "ring-2 ring-primary" : ""
      } ${data.dimmed ? "opacity-35" : ""} ${data.is_frozen ? "border-dashed" : ""}`}
    >
      <Handle type="target" position={Position.Top} className="size-1.5! bg-muted-foreground!" />
      <div className="truncate text-sm font-medium" title={data.name}>
        {data.name}
      </div>
      <div className="text-xs text-muted-foreground">
        {kindLabel(data.kind)}
        {data.is_frozen ? "（冻结）" : ""}
      </div>
      <Handle type="source" position={Position.Bottom} className="size-1.5! bg-muted-foreground!" />
    </div>
  )
}

const nodeTypes = { subject: SubjectNode }

/** tidy tree 布局：递归求子树宽度，父节点居中于最左/最右子节点之间。 */
function layoutTree(nodes) {
  const childrenOf = new Map()
  for (const n of nodes) {
    const key = n.parent_id ?? "__root__"
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key).push(n)
  }
  const out = []
  let cursor = 0
  const walk = (node, depth) => {
    const kids = childrenOf.get(node.id) ?? []
    let x
    if (kids.length === 0) {
      x = cursor * H_GAP
      cursor += 1
    } else {
      const xs = kids.map((k) => walk(k, depth + 1))
      x = (xs[0] + xs[xs.length - 1]) / 2
    }
    out.push({
      id: node.id,
      type: "subject",
      position: { x, y: depth * V_GAP },
      data: { name: node.name, kind: node.kind, scope: node.scope, is_frozen: node.is_frozen },
      draggable: true,
    })
    return x
  }
  for (const root of childrenOf.get("__root__") ?? []) walk(root, 0)
  return out
}

function Canvas({ nodes: rawNodes }) {
  const router = useRouter()
  const byId = useMemo(() => new Map((rawNodes ?? []).map((n) => [n.id, n])), [rawNodes])

  const [nodes, setNodes, onNodesChange] = useNodesState(useMemo(() => layoutTree(rawNodes ?? []), [rawNodes]))
  const [edges, , onEdgesChange] = useEdgesState(
    useMemo(
      () =>
        (rawNodes ?? [])
          .filter((n) => n.parent_id)
          .map((n) => ({ id: `${n.parent_id}-${n.id}`, source: n.parent_id, target: n.id, type: "smoothstep" })),
      [rawNodes]
    )
  )

  const [draggingId, setDraggingId] = useState(null)
  const [pending, setPending] = useState(null) // {node, target} —— 等确认的搬移
  const [busy, setBusy] = useState(false)

  const isDescendant = useCallback(
    (maybeChildId, ancestorId) => {
      let cur = byId.get(maybeChildId)
      let guard = 0
      while (cur?.parent_id && guard++ < 32) {
        if (cur.parent_id === ancestorId) return true
        cur = byId.get(cur.parent_id)
      }
      return false
    },
    [byId]
  )

  const canDrop = useCallback(
    (dragged, target) => {
      if (!dragged || !target || dragged.id === target.id) return false
      if (dragged.scope !== target.scope) return false
      if (isDescendant(target.id, dragged.id)) return false // 不能放进自己的后代（SQL 也会挡）
      return childKinds(target.scope, target.kind).includes(dragged.kind)
    },
    [isDescendant]
  )

  /** 落点判定：被拖动节点的中心落在谁身上。自己算比调 getIntersectingNodes 可控。 */
  function targetAt(dragged, all) {
    const cx = dragged.position.x + NODE_W / 2
    const cy = dragged.position.y + NODE_H / 2
    return (
      all.find((n) => {
        if (n.id === dragged.id) return false
        return cx >= n.position.x && cx <= n.position.x + NODE_W && cy >= n.position.y && cy <= n.position.y + NODE_H
      }) ?? null
    )
  }

  function onDragStart(_, node) {
    setDraggingId(node.id)
    setNodes((ns) =>
      ns.map((n) => ({ ...n, data: { ...n.data, dimmed: !canDrop(byId.get(node.id), byId.get(n.id)) } }))
    )
  }

  function onDragStop(_, node) {
    setDraggingId(null)
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, dimmed: false } })))
    const target = targetAt(node, nodes)
    if (!target) return
    const dragged = byId.get(node.id)
    const dest = byId.get(target.id)
    if (!canDrop(dragged, dest)) {
      toast.warning(`不能把「${dragged.name}」放到「${dest.name}」下面`)
      return
    }
    setPending({ node: dragged, target: dest })
  }

  async function confirmMove() {
    if (!pending) return
    setBusy(true)
    const { error } = await createClient().rpc("admin_move_subject_node", {
      p_node_id: pending.node.id,
      p_new_parent_id: pending.target.id,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(`「${pending.node.name}」已移到「${pending.target.name}」下`)
    setPending(null)
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        拖动节点放到另一个节点上即可改挂点（只允许放到层级合法的父节点上，放不下的会变淡）。
        题目的挂点跟着节点走，不用重新挂题。
      </p>
      <div className="h-[60vh] min-h-96 overflow-hidden rounded-xl border">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={onDragStart}
          onNodeDragStop={onDragStop}
          nodesConnectable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          minZoom={0.2}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* ConfirmDialog 是**条件挂载**的（它自己没有 open 参数，见该文件头注）。
          它自带 " 改挂点" 的说明：子节点与题目会一起跟过去 —— 这句话必须说，否则
          管理员会以为只是改了这一个节点。 */}
      {pending && (
        <ConfirmDialog
          title="改挂点"
          description={`把「${pending.node.name}」（${kindLabel(pending.node.kind)}）移到「${pending.target.name}」（${kindLabel(pending.target.kind)}）下面？它下面已有的子节点与题目会一起跟过去。`}
          confirmText="确认搬移"
          busy={busy}
          onConfirm={confirmMove}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  )
}

export function TreeCanvas({ nodes }) {
  return (
    <ReactFlowProvider>
      <Canvas nodes={nodes} />
    </ReactFlowProvider>
  )
}
