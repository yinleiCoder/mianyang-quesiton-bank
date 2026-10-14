"use client"

// 科目树的两个视图：**列表维护**（改名/冻结/删除/建节点）与**画布**（拖拽改挂点）。
//
// 为什么是并列的两个视图而不是二选一：它们擅长的事不一样 ——
// 改名、冻结、删除这类"对一个节点做点什么"在列表里是一行按钮的事，画布上反而要多点两下；
// 而"这个知识点该挂在谁下面"在列表里要读路径、在画布上拖一下就完了。
// 数据与视图状态都放在这一层，两个视图拿的是**同一份活数据**。
//
// ⚠ 别退回"每个视图各自 useState(nodes)"：切换视图是卸载重建，组件内的 useState 会重新
//   落回页面那一次查询的结果 —— 而那份数据来自服务端缓存，刚建好的节点可能不在里面，
//   于是"建完明明看得到、切一下视图就没了"（2026-10-14 报的就是这个）。
//   写成功后 refreshList() 重查一次，切来切去都是新的。
import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { subjectNodesQuery } from "@/lib/subject-nodes"
import { TreeManager } from "@/components/admin/tree-manager"
import { TreeCanvas } from "@/components/admin/tree-canvas"

const VIEWS = [
  { key: "list", label: "列表维护" },
  { key: "canvas", label: "画布（拖拽改挂点）" },
]

export function TreeViews({ nodes }) {
  const [view, setView] = useState("list")
  const [list, setList] = useState(nodes)

  // 浏览器端直查全量节点：不依赖 SSR 新鲜度，也不依赖 router.refresh()
  async function refreshList() {
    const { data } = await subjectNodesQuery(createClient(), { sorted: true })
    if (data) setList(data)
  }

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
      {view === "list" ? (
        <TreeManager nodes={list} onChanged={refreshList} />
      ) : (
        <TreeCanvas nodes={list} onChanged={refreshList} />
      )}
    </div>
  )
}
