"use client"

// 左栏题库选择器：只列**已入库且在线**的题（"只能拖拽使用题库中的题目"这条要求的落点）。
//
// 取数走浏览器端 PostgREST，与 /bank 列表同一个口径（RLS 兜底，这里也显式过滤）。
// 不带服务端 RPC：筛选是高频交互，每次打一次 RPC 往返不如让 PostgREST 直接出。
import { useCallback, useEffect, useRef, useState } from "react"
import { useDraggable } from "@dnd-kit/core"
import { createClient } from "@/lib/supabase/client"
import { contentSummary, qtypeLabel, qtypeShortLabel, difficultyLabel, QTYPES, DIFFICULTIES } from "@/lib/question-model"
import { indexNodes, subtreeIdsOf } from "@/lib/subject-nodes"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { SearchIcon, PlusIcon, GripVerticalIcon } from "lucide-react"

const PAGE_SIZE = 20
// LIKE 通配符转义：关键词里的 %/_ 要按字面匹配（与 /bank 页同口径）
const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

function DraggableRow({ row, onAdd }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `bank:${row.question_id}`,
    data: { type: "bank", row },
  })
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border border-border/70 bg-card p-2 text-xs ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          className="mt-0.5 cursor-grab touch-none text-muted-foreground hover:text-foreground"
          aria-label="拖到卷面"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="secondary" className="font-normal">
              {qtypeShortLabel(row.qtype)}
            </Badge>
            <span className="text-muted-foreground">难度 {difficultyLabel(row.difficulty)}</span>
          </div>
          <p className="mt-0.5 line-clamp-2">{contentSummary(row.content) || "（无题干）"}</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0"
          title="加入目标大题"
          onClick={() => onAdd(row)}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

export function QuestionPicker({ nodes, targetSections, targetSectionKey, onTargetSectionChange, onAdd, existingIds }) {
  const supabase = createClient()
  const [kw, setKw] = useState("")
  const [qtype, setQtype] = useState("")
  const [diff, setDiff] = useState("")
  const [node, setNode] = useState("")
  const [rows, setRows] = useState([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  // 输入防抖：教师打字很快，每敲一个字打一次库会拖慢整个编辑器
  const timer = useRef(null)

  const { byId: nodeMap } = indexNodes(nodes)
  const attachable = nodes.filter((n) => n.kind === "discipline" || n.kind === "course")

  const load = useCallback(
    async (pageNo) => {
      setLoading(true)
      const subtree = node && nodeMap.has(node) ? subtreeIdsOf(nodes, node) : null
      if (subtree && subtree.length === 0) {
        setRows([])
        setCount(0)
        setLoading(false)
        return
      }
      let b = supabase
        .from("question_versions")
        .select(
          "id, question_id, qtype, difficulty, content, published_at, question:questions!question_versions_question_id_fkey!inner(course_node_id, state)",
          { count: "exact" }
        )
        .eq("status", "published")
        .eq("question.state", "live")
        .order("published_at", { ascending: false })
      if (qtype) b = b.eq("qtype", qtype)
      if (diff) b = b.eq("difficulty", Number(diff))
      if (kw.trim()) b = b.ilike("search_text", `%${escapeLike(kw.trim())}%`)
      if (subtree) b = b.in("question.course_node_id", subtree)
      const res = await b.range((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE - 1)
      setLoading(false)
      if (res.error) {
        setRows([])
        setCount(0)
        return
      }
      setRows(res.data ?? [])
      setCount(res.count ?? 0)
    },
    [supabase, kw, qtype, diff, node, nodes, nodeMap]
  )

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setPage(1)
      load(1)
    }, 250)
    return () => timer.current && clearTimeout(timer.current)
  }, [load])

  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="space-y-2">
        <div className="relative">
          <SearchIcon className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="搜索题干关键词"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <select
            value={qtype}
            onChange={(e) => setQtype(e.target.value)}
            className="h-8 rounded-md border bg-transparent px-2 text-sm"
          >
            <option value="">全部题型</option>
            {QTYPES.map((q) => (
              <option key={q.value} value={q.value}>
                {qtypeLabel(q.value)}
              </option>
            ))}
          </select>
          <select
            value={diff}
            onChange={(e) => setDiff(e.target.value)}
            className="h-8 rounded-md border bg-transparent px-2 text-sm"
          >
            <option value="">全部难度</option>
            {DIFFICULTIES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <select
          value={node}
          onChange={(e) => setNode(e.target.value)}
          className="h-8 w-full rounded-md border bg-transparent px-2 text-sm"
        >
          <option value="">全部科目</option>
          {attachable.map((n) => (
            <option key={n.id} value={n.id}>
              {nodeMap.get(n.id)?.path ?? n.name}
            </option>
          ))}
        </select>
        {targetSections.length > 1 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">「+」加到</span>
            <select
              value={targetSectionKey}
              onChange={(e) => onTargetSectionChange(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-1.5"
            >
              {targetSections.map((s, i) => (
                <option key={s.key} value={s.key}>
                  {i + 1}. {s.title || `第${i + 1}大题`}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {loading && <p className="py-4 text-center text-xs text-muted-foreground">加载中…</p>}
        {!loading && rows.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground">没有找到符合条件的题目</p>
        )}
        {rows.map((row) => {
          const used = existingIds.has(row.question_id)
          return used ? (
            <div key={row.id} className="rounded-lg border border-dashed p-2 text-xs text-muted-foreground">
              已在卷内 · {qtypeShortLabel(row.qtype)} · {contentSummary(row.content).slice(0, 40)}
            </div>
          ) : (
            <DraggableRow key={row.id} row={row} onAdd={onAdd} />
          )
        })}
      </div>

      <div className="flex items-center justify-between border-t pt-2 text-xs text-muted-foreground">
        <span>共 {count} 题</span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={page <= 1 || loading}
            onClick={() => {
              const p = page - 1
              setPage(p)
              load(p)
            }}
          >
            上一页
          </Button>
          <span className="tabular-nums">
            {page}/{pages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page >= pages || loading}
            onClick={() => {
              const p = page + 1
              setPage(p)
              load(p)
            }}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  )
}
