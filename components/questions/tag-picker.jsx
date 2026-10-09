"use client"

// 知识点标签选择器：搜索已有标签（同名不区分大小写）+ 回车新建（create_tag RPC）。
// value: [{id,name}]（新标签即时回调）；标签随草稿保存，改名校验在提交时走 DB 快照。
//
// **学科隔离 + 层级（0096）**：候选只出**这道题所属科目子树下**的知识点，
// 新键的标签直接落在那个科目上。隔离靠的是"新建时就归位"这一条——
// 只筛不建，教师一敲回车就又造出一个跨学科的裸标签，隔离当天就漏。
//
// subjectNodeId 为空时（题目还没选科目）**不过滤**：那时连"属于哪个学科"都还没定，
// 按 null 硬筛只会把候选清空，是坏掉而不是隔离。
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { createFuse, searchFuse } from "@/lib/fuzzy"
import { useDebounced } from "@/lib/use-debounced"
import { tagIndex, tagsInScope, TAG_FULL_COLUMNS } from "@/lib/tag-tree"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Loader2Icon, PlusIcon, SearchIcon, XIcon } from "lucide-react"

export function TagPicker({
  value = [],
  onChange,
  allowCreate = true,
  subjectNodeId = null,
  nodes = [],
}) {
  const [all, setAll] = useState(null) // null=加载中；全量标签列表（量级小）
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const supabase = createClient()
      const { data } = await supabase.from("tags").select(TAG_FULL_COLUMNS).order("name")
      if (alive) setAll(data ?? [])
    })()
    return () => {
      alive = false
    }
  }, [])

  // 卡在"科目还没选"上：这时不筛（见文件头），但要说一句，
  // 否则教师会以为知识点怎么变少了。
  const scoped = Boolean(subjectNodeId)
  const pool = useMemo(
    () => tagsInScope(all, subjectNodeId, nodes),
    [all, subjectNodeId, nodes]
  )
  const { ancestorPathOf } = useMemo(() => tagIndex(all ?? []), [all])

  const selectedIds = new Set(value.map((t) => t.id))
  const s = q.trim().toLowerCase()
  // 候选：未选中的标签。空输入 = 前 8 个；输入时走**模糊匹配**——
  // 标签是人手敲的，"excel函数" 与 "函数 Excel" 该搜到同一个（includes 做不到）。
  // 列表小（全量在客户端），防抖只为统一口径，150ms 感觉不出来。
  const qd = useDebounced(q.trim(), 150)
  const fuse = useMemo(() => createFuse(pool, ["name"]), [pool])
  const suggestions = useMemo(() => {
    if (!qd) return pool.filter((t) => !selectedIds.has(t.id)).slice(0, 8)
    return searchFuse(fuse, qd, 8).filter((t) => !selectedIds.has(t.id))
    // selectedIds 每次渲染都是新的 Set，但语义只跟 value 走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, fuse, qd, value])

  const addExisting = (t) => {
    onChange([...value, t])
    setQ("")
  }

  async function createAndAdd() {
    if (creating) return
    setCreating(true)
    const supabase = createClient()
    // 带上科目：新知识点从出生起就归在这个学科下（0096）。
    // 只传 p_name 的旧写法会造出"未归类"的裸标签，正是这次要治的病。
    const { data: id, error } = await supabase.rpc("create_tag", {
      p_name: s,
      p_subject_node_id: subjectNodeId,
    })
    setCreating(false)
    if (error) {
      // 同一学科下已有同名 → 找到并选中（**只在候选池里找**：
      // 别的学科下同名的标签不该被这道题选中）
      const dup = pool.find((t) => t.name.toLowerCase() === s)
      if (dup) {
        if (!selectedIds.has(dup.id)) addExisting(dup)
        else toast.info("该标签已在下方列表中")
        return
      }
      toast.error(error.message)
      return
    }
    const tag = { id, name: q.trim(), subject_node_id: subjectNodeId, parent_id: null }
    setAll((prev) => (prev ? [...prev, tag] : [tag]))
    addExisting(tag)
  }

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      const exact = pool.find(
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
              suggestions.map((t) => {
                // 有父级才显示路径，且只显示**祖先**那段（自己的名字已经在左边）
                const ancestors = ancestorPathOf(t.id)
                return (
                  <button
                    key={t.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      addExisting(t)
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="truncate">
                      {ancestors && (
                        <span className="text-muted-foreground">{ancestors} / </span>
                      )}
                      {t.name}
                    </span>
                    {q.trim() && (
                      <span className="shrink-0 text-xs text-muted-foreground">已存在</span>
                    )}
                  </button>
                )
              })
            ) : s ? (
              // 无匹配 → 回车/点击新建（名称即输入值，落在本题所属科目下）
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
                {value.length ? "已选择全部可选标签" : "暂无可选标签，输入名称回车即可创建"}
              </p>
            )}
          </div>
        )}
      </div>
      {!scoped && (
        <p className="text-xs text-muted-foreground">
          还没选科目：候选暂列全部知识点。选定科目后只显示该学科下的。
        </p>
      )}
    </div>
  )
}
