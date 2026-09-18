"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { buildTrees, kindLabel, scopeLabel } from "@/lib/subject-nodes"

// 行组件定义在模块级：放在 TreePicker 内部会因每次渲染都产生新的组件类型，
// 导致整棵子树被卸载重挂（已展开/滚动位置与 DOM 全部重建）。
function Row({ entry, depth, canPick, onPick, blockedLabel }) {
  const { node, children } = entry
  const allowed = canPick(node)
  return (
    <>
      <button
        type="button"
        disabled={!allowed}
        onClick={() => onPick(node)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="truncate font-medium">{node.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {kindLabel(node.kind)}
          {node.is_frozen ? "（冻结）" : !allowed ? blockedLabel : ""}
        </span>
      </button>
      {children.map((c) => (
        <Row
          key={c.node.id}
          entry={c}
          depth={depth + 1}
          canPick={canPick}
          onPick={onPick}
          blockedLabel={blockedLabel}
        />
      ))}
    </>
  )
}

// 树形节点选择器：公共/专业两棵静态树，点击行回调所选节点
// pickable：可选谓词（默认全部可选）；false 的节点置灰不可点（出题时仅可挂题节点可选）
// blockedLabel：置灰原因的后缀文案。默认「（不可挂题）」是出题场景的说法；
//   选专业/班级这类场景传「（不可选）」，否则读起来是答非所问。
export function TreePicker({
  open,
  onOpenChange,
  nodes,
  onSelect,
  pickable,
  title = "选择科目节点",
  hint,
  blockedLabel = "（不可挂题）",
}) {
  const trees = useMemo(() => buildTrees(nodes), [nodes])
  const [scopeTab, setScopeTab] = useState(null)
  const canPick = pickable ?? (() => true)

  useEffect(() => {
    if (open) setScopeTab(null)
  }, [open])

  function pick(node) {
    if (!canPick(node)) return
    onOpenChange(false)
    onSelect?.(node)
  }

  const scopes = [
    { key: "common", label: scopeLabel("common"), trees: trees.common },
    { key: "vocational", label: scopeLabel("vocational"), trees: trees.vocational },
  ]
  const active = scopes.find((s) => s.key === (scopeTab ?? scopes[0].key))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {hint ?? "按目录切换；点击节点完成选择（任命可作用于节点及其后代科目的题目）。"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {scopes.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScopeTab(s.key)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                active.key === s.key ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="max-h-[55vh] overflow-y-auto rounded-md border p-2">
          {active.trees.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              该目录下还没有节点，请先到「科目树维护」创建
            </p>
          ) : (
            active.trees.map((t) => (
              <Row
                key={t.node.id}
                entry={t}
                depth={0}
                canPick={canPick}
                onPick={pick}
                blockedLabel={blockedLabel}
              />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
