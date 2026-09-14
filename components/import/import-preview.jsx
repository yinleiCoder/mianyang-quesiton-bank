"use client"

// 校对与入库：解析出来的题先在这里过一遍人工，确认后才生成草稿。
//
// 为什么必须有这一步：模型一定会出错（漏答案、选项粘连、把页眉当题干）。
// 让教师在这里改，比让他到「我的题目」的 200 份草稿里找那 3 道错题便宜得多。
// 入库走 import_questions_draft，**一次最多 25 道**（authenticated 角色的
// statement_timeout 是 8s，几百题一个事务必然超时），所以这里自动分片。

import * as React from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { FLAG_LABELS } from "@/lib/import-jobs"
import { blocksToPlain, textToBlocks, draftIssues } from "@/lib/import-pipeline"
import { qtypeLabel, DIFFICULTIES } from "@/lib/question-model"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ImportItemEditor } from "@/components/import/import-item-editor"
import { CheckCircle2Icon, Loader2Icon, PencilIcon, Undo2Icon, XCircleIcon } from "lucide-react"

const CHUNK = 25

const FILTERS = [
  { key: "all", label: "全部", match: () => true },
  { key: "noanswer", label: "缺答案", match: (i) => needsAnswer(i) },
  { key: "flagged", label: "有提示", match: (i) => i.flags.length > 0 },
  { key: "imported", label: "已入库", match: (i) => i.status === "imported" },
]

// 「缺答案」= 入库会被拒的那一类（choices 没选 / 判断没值 / 填空没答 / 主观没参考 / 空位对不上）
const needsAnswer = (it) => draftIssues(it.qtype, it.content).some((s) => s.includes("答案") || s.includes("空位"))

// 行内展示答案：一眼能看出"这题有没有答案"。返回 null 表示没有答案
function answerText(content) {
  const a = content?.answer
  if (!a) return null
  if (a.type === "choice") return a.keys?.length ? a.keys.join("") : null
  if (a.type === "tf") return a.value === true ? "对" : a.value === false ? "错" : null
  if (a.type === "blank") {
    const vs = (a.values ?? []).filter((v) => String(v ?? "").trim() !== "")
    return vs.length ? vs.join(" / ") : null
  }
  if (a.type === "text") {
    const ss = (a.samples ?? []).filter(Boolean)
    return ss.length ? ss[0].slice(0, 24) + (ss[0].length > 24 ? "…" : "") : null
  }
  return null
}

export function ImportPreview({ job, items, onRefresh }) {
  const [filter, setFilter] = React.useState("all")
  const [editing, setEditing] = React.useState(null) // item id（条件挂载用）
  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState(null)

  const list = React.useMemo(() => items.filter(FILTERS.find((f) => f.key === filter).match), [items, filter])
  // 默认全部保留；缺答案的不勾（入库必然被 DB 拒），但教师可以手动勾上作为"待补"占位
  const keptIds = React.useMemo(
    () => items.filter((i) => i.status === "kept" || i.status === "imported").map((i) => i.id),
    [items]
  )

  // 批量勾选时跳过"入库必被拒"的题：与其让它们到入库时报错，不如现在就留下让人补
  async function keepAll() {
    const ok = list.filter((i) => i.status === "pending" && draftIssues(i.qtype, i.content).length === 0)
    const bad = list.filter((i) => i.status === "pending" && draftIssues(i.qtype, i.content).length > 0)
    if (ok.length === 0 && bad.length === 0) return
    if (ok.length > 0) await setStatus(ok.map((i) => i.id), "kept")
    if (bad.length > 0) {
      toast.warning(`已保留 ${ok.length} 道；另有 ${bad.length} 道缺答案或空位对不上，请用「补答案」逐题补全`)
      setFilter("noanswer")
    } else {
      toast.success(`已保留 ${ok.length} 道`)
    }
  }

  async function setStatus(ids, status) {
    if (ids.length === 0) return
    const supabase = createClient()
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await supabase.rpc("import_set_items_status", {
        p_item_ids: ids.slice(i, i + 500),
        p_status: status,
      })
      if (error) return toast.error(error.message)
    }
    await onRefresh()
  }

  async function importSelected() {
    const ids = items.filter((i) => i.status === "kept" && i.status !== "imported").map((i) => i.id)
    if (ids.length === 0) return toast.error("没有勾选任何题目")
    setBusy(true)
    setProgress({ done: 0, total: ids.length })
    const supabase = createClient()
    let ok = 0
    let failed = 0
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK)
        const { data, error } = await supabase.rpc("import_questions_draft", {
          p_job_id: job.id,
          p_item_ids: chunk,
        })
        if (error) {
          toast.error(error.message)
          break
        }
        for (const r of data ?? []) r.ok ? ok++ : failed++
        setProgress({ done: Math.min(i + CHUNK, ids.length), total: ids.length })
      }
      if (ok > 0) toast.success(`已生成 ${ok} 份草稿${failed ? `，${failed} 道失败（见行内提示）` : ""}`)
      else if (failed > 0) toast.error(`${failed} 道没能入库，请看行内原因`)
    } finally {
      setBusy(false)
      setProgress(null)
      await onRefresh()
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              filter === f.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/60"
            }`}
          >
            {f.label}
            <span className="ml-1 opacity-70">{items.filter(f.match).length}</span>
          </button>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={keepAll} disabled={busy}>
            全部保留（跳过缺答案的）
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setStatus(list.map((i) => i.id), "skipped")} disabled={busy}>
            本页全不选
          </Button>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <span>
          已勾选 <b>{keptIds.length}</b> 道（共 {items.length} 道）
        </span>
        <Button size="sm" onClick={importSelected} disabled={busy || keptIds.length === 0}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : <CheckCircle2Icon className="size-4" />}
          确认入库，生成草稿
        </Button>
        {progress && (
          <span className="text-xs text-muted-foreground">
            已处理 {progress.done}/{progress.total}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          生成的草稿在「我的题目」里，还要你手动提交才会进审核。
        </span>
      </div>

      <div className="space-y-2">
        {list.length === 0 && (
          <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
            这个筛选下没有题目
          </p>
        )}
        {list.map((it) => {
          const kept = it.status === "kept" || it.status === "imported"
          const issues = draftIssues(it.qtype, it.content)
          return (
            <div key={it.id} className="rounded-xl border p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={kept}
                  disabled={it.status === "imported" || busy}
                  title={needsAnswer(it) ? "这道题还缺答案，勾选前请先补全" : ""}
                  onChange={(e) => {
                    // 缺答案的题勾不上：直接把编辑器打开，别让它以"保留"的姿态混到入库时才报错
                    if (e.target.checked && needsAnswer(it)) {
                      toast.warning("这道题还缺答案，请先补全再保留")
                      setEditing(it.id)
                      return
                    }
                    setStatus([it.id], e.target.checked ? "kept" : "skipped")
                  }}
                />
                <span className="font-medium">{it.qno ? `第 ${it.qno} 题` : `第 ${it.page_no} 页`}</span>
                <Badge variant="outline" className="px-1.5 py-0 text-xs">
                  {qtypeLabel(it.qtype)}
                </Badge>
                <span className="text-muted-foreground">
                  {DIFFICULTIES.find((d) => d.value === it.difficulty)?.label ?? it.difficulty}
                </span>
                <span className="text-muted-foreground/70">P{it.page_no}</span>
                {it.flags.map((f) => (
                  <span
                    key={f}
                    title={FLAG_LABELS[f]?.hint ?? ""}
                    className={`rounded px-1.5 py-0.5 ${
                      f === "answer_missing" || f === "blank_mismatch"
                        ? "bg-rose-100 text-rose-700"
                        : f === "ai_analysis"
                          ? "bg-violet-100 text-violet-700"
                          : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {FLAG_LABELS[f]?.text ?? f}
                  </span>
                ))}
                {it.status === "imported" && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">已入库</span>
                )}
                {it.status === "failed" && (
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700" title={it.error ?? ""}>
                    入库失败
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  {needsAnswer(it) && it.status !== "imported" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 border-rose-300 px-2 text-rose-700 hover:bg-rose-50"
                      onClick={() => setEditing(it.id)}
                    >
                      补答案
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title="编辑"
                    disabled={it.status === "imported"}
                    onClick={() => setEditing(editing === it.id ? null : it.id)}
                  >
                    {editing === it.id ? <Undo2Icon className="size-3.5" /> : <PencilIcon className="size-3.5" />}
                  </Button>
                  {it.status !== "imported" && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="不导入这道题"
                      onClick={() => setStatus([it.id], "skipped")}
                    >
                      <XCircleIcon className="size-3.5" />
                    </Button>
                  )}
                </span>
              </div>

              <p className="mt-2 line-clamp-3 text-sm text-foreground/90">
                {blocksToPlain(it.content?.stem) || <span className="text-muted-foreground">（题干为空）</span>}
              </p>
              {/* 答案一眼可见：不需要展开编辑器就能看出这题是否缺答案 */}
              <p className="mt-1 text-xs">
                {answerText(it.content) ? (
                  <span className="text-muted-foreground">
                    答案：<span className="text-foreground/90">{answerText(it.content)}</span>
                  </span>
                ) : (
                  <span className="text-rose-600">未指定答案</span>
                )}
              </p>
              {it.source_quote && (
                <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">
                  原文：{it.source_quote}
                </p>
              )}
              {issues.length > 0 && (
                <p className="mt-1 text-xs text-rose-600">
                  入库会被拒绝：{issues.slice(0, 2).join("；")}
                  {issues.length > 2 && ` 等 ${issues.length} 项`}
                </p>
              )}
              {it.status === "failed" && it.error && (
                <p className="mt-1 text-xs text-rose-600">入库失败原因：{it.error}</p>
              )}

              {/* 条件挂载：React Compiler 会把常挂载组件里被记忆化闭包捕获的 state.prop
                  提到渲染期求值，item 为 null 时首渲染就崩（本项目踩过） */}
              {editing === it.id && (
                <ImportItemEditor item={it} onClose={() => setEditing(null)} onSaved={onRefresh} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
