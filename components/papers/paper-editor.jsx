"use client"

// 组卷编辑器外壳：三栏（题库 / 卷面 / 属性）+ 拖拽 + 保存与提交。
//
// 状态是单一 useReducer，派生量全部现算（见 lib/paper-editor-state.js 顶部注释）。
// 保存是**整卷 PUT**：delete-then-insert 一个事务，与 save_paper_draft 对齐。
// 并发由 updated_us 乐观锁兜住——服务端比对不上会返回 40001，这里提示教师刷新。
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import {
  paperEditorReducer,
  fromSnapshot,
  buildView,
  toSavePayload,
  itemFromBank,
} from "@/lib/paper-editor-state"
import { paperIssues } from "@/lib/paper-model"
import { qtypeShortLabel } from "@/lib/question-model"
import { paperStatusChip } from "@/lib/paper-workbench"
import { QuestionPicker } from "@/components/papers/question-picker"
import { PaperCanvas } from "@/components/papers/paper-canvas"
import { PaperInspector } from "@/components/papers/paper-inspector"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  SaveIcon,
  SendIcon,
  ArrowLeftIcon,
  RefreshCwIcon,
  PrinterIcon,
  ExternalLinkIcon,
} from "lucide-react"

export function PaperEditor({ initialSnapshot, nodes }) {
  const router = useRouter()
  const supabase = createClient()
  const [state, dispatch] = useReducer(paperEditorReducer, initialSnapshot, fromSnapshot)
  const [selected, setSelected] = useState(null)
  const [targetSectionKey, setTargetSectionKey] = useState(null)
  const [saving, setSaving] = useState(false)
  // 拖拽中要渲染 DragOverlay，得记住被拖的是哪一条
  const [activeRow, setActiveRow] = useState(null)

  const view = useMemo(() => buildView(state), [state])
  const issues = useMemo(
    () =>
      paperIssues({
        sections: view.sections,
        target_score: view.target,
      }),
    [view]
  )
  const existingIds = useMemo(
    () => new Set(state.sections.flatMap((s) => s.items.map((i) => i.question_id))),
    [state.sections]
  )

  const firstSectionKey = state.sections[0]?.key ?? null
  const effectiveTargetKey = targetSectionKey ?? firstSectionKey
  const targetIndex = Math.max(
    0,
    state.sections.findIndex((s) => s.key === effectiveTargetKey)
  )

  // reactCompiler 会记忆化，但传感器与碰撞检测对象本身必须是稳定引用，
  // 否则每次渲染都会让 dnd-kit 重新测量一遍
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const save = useCallback(
    async ({ silent = false } = {}) => {
      setSaving(true)
      const payload = toSavePayload(state)
      const { data, error } = await supabase.rpc("save_paper_draft", {
        p_version_id: state.versionId,
        p_meta: payload.meta,
        p_sections: payload.sections,
        p_expected_us: state.updatedUs,
      })
      setSaving(false)
      if (error) {
        // 40001 = 乐观锁冲突（服务端定义），与其它错误区分开提示
        toast.error(error.code === "40001" ? "这份草稿在别处被修改过，请刷新页面后重试" : error.message)
        return false
      }
      dispatch({ type: "saved", updatedUs: data.updated_us })
      if (!silent) toast.success(`已保存 · 共 ${data.item_count} 题 ${data.total_score} 分`)
      return true
    },
    [supabase, state]
  )

  // Ctrl/Cmd+S 保存；有未保存改动时离开页面拦一次
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [save])

  useEffect(() => {
    if (!state.dirty) return
    const onLeave = (e) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onLeave)
    return () => window.removeEventListener("beforeunload", onLeave)
  }, [state.dirty])

  const submit = useCallback(async () => {
    if (issues.length > 0) {
      toast.error(issues[0])
      return
    }
    if (!(await save({ silent: true }))) return
    const { error } = await supabase.rpc("submit_paper", { p_version_id: state.versionId })
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("已提交审核")
    router.push(`/papers/${state.paperId}`)
  }, [issues, save, supabase, state.versionId, state.paperId, router])

  const refreshItems = useCallback(async () => {
    if (state.dirty && !(await save({ silent: true }))) return
    const { data, error } = await supabase.rpc("paper_refresh_items", { p_version_id: state.versionId })
    if (error) {
      toast.error(error.message)
      return
    }
    if (data.fixed === 0) {
      toast.info("所有题目都已经是最新版本")
      return
    }
    toast.success(`已把 ${data.fixed} 道题刷新到题库最新版本`)
    router.refresh()
  }, [state.dirty, state.versionId, save, supabase, router])

  const onDragEnd = useCallback(
    ({ active, over }) => {
      setActiveRow(null)
      if (!over) return
      const a = active.data.current
      const o = over.data.current
      if (a?.type === "bank") {
        const item = itemFromBank(a.row)
        const index = o?.type === "item" ? o.sectionIndex : o?.sectionIndex
        if (index == null) return
        dispatch({
          type: "itemsAdd",
          index,
          at: o?.type === "item" ? o.itemIndex : undefined,
          items: [item],
        })
        return
      }
      if (a?.type === "item") {
        if (o?.type === "item") {
          if (a.sectionIndex === o.sectionIndex && a.itemIndex === o.itemIndex) return
          dispatch({
            type: "itemMove",
            fromSection: a.sectionIndex,
            fromIndex: a.itemIndex,
            toSection: o.sectionIndex,
            toIndex: o.itemIndex,
          })
        } else if (o?.type === "section" && a.sectionIndex !== o.sectionIndex) {
          dispatch({
            type: "itemMove",
            fromSection: a.sectionIndex,
            fromIndex: a.itemIndex,
            toSection: o.sectionIndex,
            toIndex: state.sections[o.sectionIndex]?.items.length ?? 0,
          })
        }
      }
    },
    [state.sections]
  )

  const moveItem = useCallback(
    (dir, sectionIndex, itemIndex) => {
      const sec = state.sections[sectionIndex]
      if (dir === "up") {
        if (itemIndex > 0) {
          dispatch({ type: "itemMove", fromSection: sectionIndex, fromIndex: itemIndex, toSection: sectionIndex, toIndex: itemIndex - 1 })
        } else if (sectionIndex > 0) {
          const prev = state.sections[sectionIndex - 1]
          dispatch({ type: "itemMove", fromSection: sectionIndex, fromIndex: itemIndex, toSection: sectionIndex - 1, toIndex: prev.items.length })
        }
      } else if (dir === "down") {
        if (itemIndex < sec.items.length - 1) {
          dispatch({ type: "itemMove", fromSection: sectionIndex, fromIndex: itemIndex, toSection: sectionIndex, toIndex: itemIndex + 1 })
        } else if (sectionIndex < state.sections.length - 1) {
          dispatch({ type: "itemMove", fromSection: sectionIndex, fromIndex: itemIndex, toSection: sectionIndex + 1, toIndex: 0 })
        }
      } else if (dir === "prevSection" && sectionIndex > 0) {
        const prev = state.sections[sectionIndex - 1]
        dispatch({ type: "itemMove", fromSection: sectionIndex, fromIndex: itemIndex, toSection: sectionIndex - 1, toIndex: prev.items.length })
      }
    },
    [state.sections]
  )

  const chip = paperStatusChip(state.status)

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-144 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={`/papers/${state.paperId}`} />}>
          <ArrowLeftIcon className="size-4" /> 返回
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {state.meta.title || "未命名试卷"}
          <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-normal ${chip.cls}`}>{chip.text}</span>
          {state.dirty && <span className="ml-2 text-xs font-normal text-amber-600">有未保存的改动</span>}
        </h1>
        <Button variant="outline" size="sm" onClick={refreshItems}>
          <RefreshCwIcon className="size-4" /> 刷新题目
        </Button>
        <Button
          variant="outline"
          size="sm" nativeButton={false} render={<a href={`/print/paper/${state.versionId}`} target="_blank" rel="noreferrer" />}
        >
          <PrinterIcon className="size-4" /> 打印预览
        </Button>
        <Button variant="outline" size="sm" onClick={() => save()} disabled={saving || !state.dirty}>
          <SaveIcon className="size-4" /> {saving ? "保存中…" : "保存"}
        </Button>
        <Button size="sm" onClick={submit} disabled={saving}>
          <SendIcon className="size-4" /> 提交审核
        </Button>
      </div>

      {issues.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p className="font-medium">提交前还需处理 {issues.length} 项：</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {issues.slice(0, 4).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setActiveRow(active.data.current?.row ?? null)}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveRow(null)}
      >
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[19rem_minmax(0,1fr)_17rem]">
          <aside className="min-h-0 rounded-xl border p-3">
            <h2 className="mb-2 text-sm font-medium">题库选题</h2>
            <QuestionPicker
              nodes={nodes}
              targetSections={state.sections}
              targetSectionKey={effectiveTargetKey}
              onTargetSectionChange={setTargetSectionKey}
              onAdd={(row) =>
                dispatch({ type: "itemsAdd", index: targetIndex, items: [itemFromBank(row)] })
              }
              existingIds={existingIds}
            />
          </aside>

          <main className="min-h-0 overflow-y-auto rounded-xl border p-3">
            <PaperCanvas
              view={view}
              selected={selected}
              onSelect={(sectionIndex, itemIndex) => setSelected({ sectionIndex, itemIndex })}
              onSectionAdd={() => dispatch({ type: "sectionAdd" })}
              onSectionUpdate={(index, patch) => dispatch({ type: "sectionUpdate", index, patch })}
              onSectionRemove={(index) => dispatch({ type: "sectionRemove", index })}
              onSectionMove={(from, to) => dispatch({ type: "sectionMove", from, to })}
              onItemRemove={(sectionIndex, itemIndex) => {
                dispatch({ type: "itemRemove", sectionIndex, itemIndex })
                setSelected(null)
              }}
              onItemMove={moveItem}
              onItemResetUnits={(sectionIndex, itemIndex) =>
                dispatch({ type: "itemResetUnits", sectionIndex, itemIndex })
              }
            />
          </main>

          <aside className="min-h-0 overflow-y-auto rounded-xl border p-3">
            <PaperInspector
              meta={state.meta}
              onMeta={(patch) => dispatch({ type: "meta", patch })}
              selected={
                selected && view.sections[selected.sectionIndex]
                  ? {
                      section: view.sections[selected.sectionIndex],
                      item: view.sections[selected.sectionIndex].items[selected.itemIndex],
                      sectionIndex: selected.sectionIndex,
                      itemIndex: selected.itemIndex,
                    }
                  : null
              }
              onUnits={(sectionIndex, itemIndex, units) =>
                dispatch({ type: "itemUnits", sectionIndex, itemIndex, units })
              }
              onResetUnits={(sectionIndex, itemIndex) =>
                dispatch({ type: "itemResetUnits", sectionIndex, itemIndex })
              }
              onNote={(sectionIndex, itemIndex, note) =>
                dispatch({ type: "itemNote", sectionIndex, itemIndex, note })
              }
            />
          </aside>
        </div>

        {/* DragOverlay 必须有：在滚动容器里拖动时，被拖元素会被裁剪/闪烁 */}
        <DragOverlay dropAnimation={null}>
          {activeRow ? (
            <div className="max-w-sm rounded-lg border bg-card p-2 text-xs shadow-lg">
              <Badge variant="secondary" className="font-normal">
                {qtypeShortLabel(activeRow.qtype)}
              </Badge>
              <p className="mt-1 line-clamp-2">{activeRow.summary}</p>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <p className="text-xs text-muted-foreground">
        快捷键 Ctrl/⌘+S 保存。题目只能来自题库——要新增题目请到
        <Link href="/questions/import" className="mx-1 inline-flex items-center gap-0.5 text-primary hover:underline">
          AI 智能解析 <ExternalLinkIcon className="size-3" />
        </Link>
        或
        <Link href="/questions/new" className="mx-1 text-primary hover:underline">
          手动出题
        </Link>
        ，经两级审核入库后即可拖入这里的卷面。
      </p>
    </div>
  )
}
