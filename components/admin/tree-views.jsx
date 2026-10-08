"use client"

// 科目树的两个视图：**列表维护**（改名/冻结/删除/建节点）与**画布**（拖拽改挂点）。
//
// 为什么是并列的两个视图而不是二选一：它们擅长的事不一样 ——
// 改名、冻结、删除这类"对一个节点做点什么"在列表里是一行按钮的事，画布上反而要多点两下；
// 而"这个知识点该挂在谁下面"在列表里要读路径、在画布上拖一下就完了。
// 状态放在这一层，两个视图各自拿同一份 nodes（数据源只有页面那一次查询）。
import { useState } from "react"
import { TreeManager } from "@/components/admin/tree-manager"
import { TreeCanvas } from "@/components/admin/tree-canvas"

const VIEWS = [
  { key: "list", label: "列表维护" },
  { key: "canvas", label: "画布（拖拽改挂点）" },
]

export function TreeViews({ nodes }) {
  const [view, setView] = useState("list")

  return (
    <div className="space-y-3">
      <div className="flex w-fit gap-1 rounded-lg bg-muted p-1">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setView(v.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              view === v.key ? "bg-background shadow-sm" : "text-muted-foreground"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === "list" ? <TreeManager nodes={nodes} /> : <TreeCanvas nodes={nodes} />}
    </div>
  )
}
