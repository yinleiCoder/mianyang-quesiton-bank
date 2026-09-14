"use client"

// 题目所属课程节点选择：可挂题节点（公共-学科 / 专业-课程）且未冻结才可选。
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TreePicker } from "@/components/admin/tree-picker"
import { isAttachable, kindLabel, nodePathOf } from "@/lib/subject-nodes"
import { FolderTreeIcon } from "lucide-react"

export function NodeField({ nodes, value, onChange }) {
  const [open, setOpen] = React.useState(false)
  const selected = value ? nodes.find((n) => n.id === value) : null

  const canPick = (node) => isAttachable(node.kind) && !node.is_frozen

  return (
    <div className="space-y-2">
      {selected ? (
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <Badge variant="outline" className="shrink-0">
            {kindLabel(selected.kind)}
          </Badge>
          <span className="min-w-0 flex-1 truncate">{nodePathOf(nodes, selected.id)}</span>
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            更换
          </Button>
        </div>
      ) : (
        <Button variant="outline" className="w-full justify-start" onClick={() => setOpen(true)}>
          <FolderTreeIcon className="size-4 text-muted-foreground" />
          选择科目节点（公共学科 / 专业课程）
        </Button>
      )}
      <TreePicker
        open={open}
        onOpenChange={setOpen}
        nodes={nodes}
        pickable={canPick}
        title="选择题目所属科目"
        hint="可挂题的节点：公共科目的学科节点、专业目录的课程节点（已冻结的不可选）。挂到某节点即覆盖该节点，与任命路由无关（题目路由只看题目挂靠节点）。"
        onSelect={(node) => {
          if (canPick(node)) onChange(node.id)
        }}
      />
    </div>
  )
}
