"use client"

// 题库筛选条：改动即改写 URL 查询参数，由服务端题库页按新条件重新装配（无本地数据状态）。
import { useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import { QTYPES } from "@/lib/question-model"
import { nodePathOf } from "@/lib/subject-nodes"
import { bankQueryString, hasBankFilters } from "@/lib/bank-query"
import { TreePicker } from "@/components/admin/tree-picker"
import { Button } from "@/components/ui/button"
import { SearchIcon, XIcon } from "lucide-react"

export function BankFilters({ nodes, tags, value }) {
  const router = useRouter()
  const pathname = usePathname() ?? "/bank"
  const [kw, setKw] = useState(value.kw ?? "")
  const [nodeOpen, setNodeOpen] = useState(false)
  const selectedNode = value.node ? (nodes ?? []).find((n) => n.id === value.node) : null

  // 改动即改写 URL（不带 page：换筛选条件回到第一页）
  function go(patch) {
    const qs = bankQueryString({ ...value, ...patch })
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const clearable = hasBankFilters(value)

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        go({ kw: kw.trim() })
      }}
    >
      {/* 每个筛选项一律 flex-col：标签在上、控件在下。用 space-y 不行——它只加外边距，
          裸 <select>（inline-block）会跟标签排到同一行，五个筛选项就会一半横一半竖。 */}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">题干关键词</span>
        <span className="relative block">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="搜题干（含子题）…"
            className="h-9 w-52 rounded-lg border border-input bg-background pl-8 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">题型</span>
        <select
          value={value.qtype ?? ""}
          onChange={(e) => go({ qtype: e.target.value })}
          className="h-9 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
        >
          <option value="">全部题型</option>
          {QTYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">难度</span>
        <select
          value={value.diff ?? ""}
          onChange={(e) => go({ diff: e.target.value })}
          className="h-9 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
        >
          <option value="">全部难度</option>
          <option value="1">易</option>
          <option value="2">中</option>
          <option value="3">难</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">科目</span>
        <span className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-w-56 justify-start font-normal"
            onClick={() => setNodeOpen(true)}
          >
            {selectedNode ? (
              <span className="truncate">{nodePathOf(nodes, selectedNode.id)}</span>
            ) : (
              <span className="text-muted-foreground">全部科目（按节点及其后代）</span>
            )}
          </Button>
          {value.node && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="清除科目筛选"
              onClick={() => go({ node: "" })}
            >
              <XIcon className="size-3.5" />
            </Button>
          )}
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">知识点标签</span>
        <select
          value={value.tag ?? ""}
          onChange={(e) => go({ tag: e.target.value })}
          className="h-9 max-w-44 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
        >
          <option value="">全部标签</option>
          {(tags ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      {clearable && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setKw("")
            router.push(pathname)
          }}
        >
          <XIcon className="size-3.5" /> 清除筛选
        </Button>
      )}
      <TreePicker
        open={nodeOpen}
        onOpenChange={setNodeOpen}
        nodes={nodes}
        title="按科目筛选"
        hint="选择任意节点：筛选该节点及其全部后代科目下已入库的题目。"
        onSelect={(node) => go({ node: node.id })}
      />
    </form>
  )
}
