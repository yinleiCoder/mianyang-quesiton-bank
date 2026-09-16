"use client"

// 知识点标签选择器：搜索已有标签（同名不区分大小写）+ 回车新建（create_tag RPC）。
// value: [{id,name}]（新标签即时回调）；标签随草稿保存，改名校验在提交时走 DB 快照。
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Loader2Icon, PlusIcon, SearchIcon, XIcon } from "lucide-react"

export function TagPicker({ value = [], onChange, allowCreate = true }) {
  const [all, setAll] = useState(null) // null=加载中；全量标签列表（量级小）
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const supabase = createClient()
      const { data } = await supabase.from("tags").select("id, name").order("name")
      if (alive) setAll(data ?? [])
    })()
    return () => {
      alive = false
    }
  }, [])

  const selectedIds = new Set(value.map((t) => t.id))
  const s = q.trim().toLowerCase()
  // 候选：未选中的标签，输入时按名过滤；空输入即"全部未选标签"（面板只展示前 8 个）
  const suggestions = (all ?? [])
    .filter((t) => !selectedIds.has(t.id) && (!s || t.name.toLowerCase().includes(s)))
    .slice(0, 8)

  const addExisting = (t) => {
    onChange([...value, t])
    setQ("")
  }

  async function createAndAdd() {
    if (creating) return
    setCreating(true)
    const supabase = createClient()
    const { data: id, error } = await supabase.rpc("create_tag", { p_name: s })
    setCreating(false)
    if (error) {
      // 已存在同义标签 → 找到并选中
      const dup = (all ?? []).find((t) => t.name.toLowerCase() === s)
      if (dup) {
        if (!selectedIds.has(dup.id)) addExisting(dup)
        else toast.info("该标签已在下方列表中")
        return
      }
      toast.error(error.message)
      return
    }
    const tag = { id, name: q.trim() }
    setAll((prev) => (prev ? [...prev, tag] : [tag]))
    addExisting(tag)
  }

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      const exact = (all ?? []).find(
        (t) => !selectedIds.has(t.id) && t.name.toLowerCase() === s
      )
      if (exact) addExisting(exact)
      else if (allowCreate && s) createAndAdd()
    }
    if (e.key === "Escape") setFocused(false)
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((t) => (
            <Badge key={t.id} variant="secondary" className="gap-1 pr-1">
              {t.name}
              <button
                type="button"
                aria-label={`移除标签 ${t.name}`}
                onClick={() => onChange(value.filter((x) => x.id !== t.id))}
                className="rounded-sm text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="relative">
        <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="搜索或输入新知识点标签，回车添加"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={onKeyDown}
        />
        {focused && (
          <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border bg-background p-1 shadow-lg">
            {all === null || creating ? (
              <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                {creating && <Loader2Icon className="size-3.5 animate-spin" />}
                {creating ? "正在创建…" : "加载中…"}
              </p>
            ) : suggestions.length > 0 ? (
              suggestions.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    addExisting(t)
                  }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span>{t.name}</span>
                  {q.trim() && <span className="shrink-0 text-xs text-muted-foreground">已存在</span>}
                </button>
              ))
            ) : s ? (
              // 无匹配 → 回车/点击新建（名称即输入值）
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  createAndAdd()
                }}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <PlusIcon className="size-3.5" />
                新建标签「{q.trim()}」
              </button>
            ) : (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">
                {value.length ? "已选择全部已有标签" : "暂无标签，输入名称回车即可创建"}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
