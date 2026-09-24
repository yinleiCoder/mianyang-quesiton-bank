"use client"

// 校对与入库：解析出来的题先在这里过一遍人工，确认后才生成草稿。
//
// 为什么必须有这一步：模型一定会出错（漏答案、选项粘连、把页眉当题干）。
// 让教师在这里改，比让他到「我的题目」的 200 份草稿里找那 3 道错题便宜得多。
// 入库走 import_questions_draft，**一次最多 25 道**（authenticated 角色的
// statement_timeout 是 8s，几百题一个事务必然超时），所以这里自动分片。
//
// 每道题三态（对齐 import_job_items.status）：待定 pending / 不导入 skipped / 纳入 kept。
// 三态都要在行上看得出来——skipped 原先没有任何标记，与 pending 长得一模一样，
// 于是「不导入」一道没勾选的题就是一次看不见的操作，被当成按钮坏了。

import { useEffect, useMemo, useState } from "react"
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
import { BuildPaperButton } from "@/components/papers/build-paper-button"
import {
  CheckCircle2Icon,
  Loader2Icon,
  PencilIcon,
  RotateCcwIcon,
  Undo2Icon,
  XCircleIcon,
} from "lucide-react"

const CHUNK = 25

const FILTERS = [
  { key: "all", label: "全部", match: () => true },
  { key: "noanswer", label: "缺答案", match: (i) => needsAnswer(i) },
  { key: "flagged", label: "有提示", match: (i) => i.flags.length > 0 },
  { key: "imported", label: "已入库", match: (i) => i.status === "imported" },
  // 「不导入」必须能筛：叉掉之后就只剩这个入口能把它们找回来
  { key: "skipped", label: "不导入", match: (i) => i.status === "skipped" },
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
  const [filter, setFilter] = useState("all")
  const [editing, setEditing] = useState(null) // item id（条件挂载用）
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  // 乐观状态：id → status，勾选/取消**先落本地**。
  //
  // 为什么必须有：复选框的 checked 来自服务端的 status，而 React 处理完 change 事件后会把
  // 受控 input 的 DOM 值打回"上次提交的 props"（react-dom 的 restoreStateOfTarget，每次
  // change 都跑）。于是"写库成功 → 父组件重新拉题 → 才勾上"这条链路上，勾选框会先弹回原样，
  // 看起来就是**单击没反应**；再点一下时刷新恰好回来了，才勾上。刷新本身还有 1.2s 节流
  // （import-page），被吞掉时就是一直不勾上。
  const [optimistic, setOptimistic] = useState({})

  // 服务端数据追上乐观值后撤掉覆盖。不在这里主动清：刷新可能被节流延后，清早了勾选会闪回去；
  // 等 items 真的变成这个值再撤，界面才是单调的
  useEffect(() => {
    setOptimistic((prev) => {
      const ids = Object.keys(prev)
      if (ids.length === 0) return prev
      const fresh = new Map(items.map((i) => [i.id, i.status]))
      const next = { ...prev }
      let dropped = false
      for (const id of ids) {
        const s = fresh.get(id)
        // 服务端追上了就撤；imported 是终态（库里不可再改），服务端说了算，永远撤
        if (s === next[id] || s === "imported") {
          delete next[id]
          dropped = true
        }
      }
      return dropped ? next : prev
    })
  }, [items])

  // 渲染、计数、入库都看这一份：界面上的勾、"已勾选 N 道"、真正提交的 id 不能各说各话
  const view = useMemo(() => {
    if (Object.keys(optimistic).length === 0) return items
    return items.map((i) =>
      optimistic[i.id] !== undefined && optimistic[i.id] !== i.status ? { ...i, status: optimistic[i.id] } : i
    )
  }, [items, optimistic])

  const list = useMemo(() => view.filter(FILTERS.find((f) => f.key === filter).match), [view, filter])

  // 跨页合并的结果：下一页把上一页末尾那半截并成了完整题，上一页那条残题就该丢掉。
  // 不自动写库（那样会跟教师手动的勾选打架），只把它标出来 + 在「全部保留」时跳过——
  // 那道残题本身是能过入库校验的，不拦一下就会以"半句话"的形态混进题库。
  const mergedPages = useMemo(
    () => new Set(view.filter((i) => i.flags.includes("merged_cross_page")).map((i) => i.page_no)),
    [view]
  )
  const superseded = (it) =>
    it.flags.includes("cross_page") &&
    !it.flags.includes("merged_cross_page") &&
    mergedPages.has(it.page_no + 1)
  // 默认全部保留；缺答案的不勾（入库必然被 DB 拒），但教师可以手动勾上作为"待补"占位
  const keptIds = useMemo(
    () => view.filter((i) => i.status === "kept" || i.status === "imported").map((i) => i.id),
    [view]
  )

  // 批量勾选时跳过两类：入库必被拒的（缺答案），以及已被下一页合并掉的残题
  async function keepAll() {
    const pending = list.filter((i) => i.status === "pending")
    const stale = pending.filter((i) => superseded(i))
    const rest = pending.filter((i) => !superseded(i))
    const ok = rest.filter((i) => draftIssues(i.qtype, i.content).length === 0)
    const bad = rest.filter((i) => draftIssues(i.qtype, i.content).length > 0)
    if (ok.length === 0 && bad.length === 0 && stale.length === 0) return
    if (ok.length > 0) await setStatus(ok.map((i) => i.id), "kept")
    if (bad.length > 0) {
      const staleNote = stale.length > 0 ? `、${stale.length} 道已在下一页合并成完整题（不勾选）` : ""
      toast.warning(
        `已保留 ${ok.length} 道；另有 ${bad.length} 道缺答案或空位对不上，请用「补答案」逐题补全${staleNote}`
      )
      setFilter("noanswer")
    } else if (stale.length > 0) {
      toast.warning(`已保留 ${ok.length} 道；${stale.length} 道被下一页合并成了完整题，未勾选（在下一页）`)
    } else {
      toast.success(`已保留 ${ok.length} 道`)
    }
  }

  async function setStatus(ids, status) {
    if (ids.length === 0) return
    // 已入库的题库里改不了（RPC 里也排除了 imported）：别写、也别盖乐观值——盖了服务端
    // 永远不会"追上"，那个勾选状态就成了库里不存在的假象（「本页全不选」会把它们一并传进来）
    const locked = new Set(view.filter((i) => i.status === "imported").map((i) => i.id))
    const target = ids.filter((id) => !locked.has(id))
    if (target.length === 0) return
    // 先改本地再写库：勾选立刻可见，不等数据库往返（见上面 optimistic 的注释）
    setOptimistic((prev) => {
      const next = { ...prev }
      for (const id of target) next[id] = status
      return next
    })
    const supabase = createClient()
    for (let i = 0; i < target.length; i += 500) {
      const { error } = await supabase.rpc("import_set_items_status", {
        p_item_ids: target.slice(i, i + 500),
        p_status: status,
      })
      if (error) {
        // 没写进去的那部分（含后面没轮到的批次）撤回乐观值，界面回到服务端的真实状态
        const failed = new Set(target.slice(i))
        setOptimistic((prev) => {
          const next = { ...prev }
          for (const id of failed) delete next[id]
          return next
        })
        return toast.error(error.message)
      }
    }
    await onRefresh()
  }

  async function importSelected() {
    const ids = view.filter((i) => i.status === "kept").map((i) => i.id)
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
            <span className="ml-1 opacity-70">{view.filter(f.match).length}</span>
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
        {/* 整卷还原模式下多给一个出口：入库 + 按大题/分值排成一份试卷草稿（0050） */}
        {job.mode === "paper" && (
          <BuildPaperButton job={job} items={items} keptIds={keptIds} onRefresh={onRefresh} />
        )}
        {progress && (
          <span className="text-xs text-muted-foreground">
            已处理 {progress.done}/{progress.total}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {job.mode === "paper"
            ? "「一键成卷」会先把题目入库，再按解析出的大题与分值还原成试卷草稿。"
            : "生成的草稿在「我的题目」里，还要你手动提交才会进审核。"}
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
          const skipped = it.status === "skipped"
          const issues = draftIssues(it.qtype, it.content)
          return (
            <div
              key={it.id}
              className={`rounded-xl border p-3 ${skipped ? "border-dashed bg-muted/30" : ""}`}
            >
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
                        : f === "ai_analysis" || f === "ai_answer"
                          // AI 生成的内容统一用紫色：它们不是原卷内容，需要人负核对责任
                          ? "bg-violet-100 text-violet-700"
                          : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {FLAG_LABELS[f]?.text ?? f}
                  </span>
                ))}
                {superseded(it) && (
                  <span
                    title={`第 ${it.page_no + 1} 页已经给出拼好的完整题：这一条是页尾的半截，不用勾选`}
                    className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                  >
                    已被下一页合并
                  </span>
                )}
                {it.status === "imported" && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">已入库</span>
                )}
                {/* skipped 没有这个标记时与「待定」长得一模一样：叉掉一道没勾选的题，
                    界面上什么都不会变，看起来就是"点了没反应" */}
                {skipped && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">不导入</span>
                )}
                {it.status === "failed" && (
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700" title={it.error ?? ""}>
                    入库失败
                  </span>
                )}
                {/* 整卷还原：把解析出的大题与分值显示出来。
                    这两项直接决定成卷后的卷面结构，抽错了要在这里就看得见，
                    而不是等进了编辑器才发现所有题都堆在一个大题里 */}
                {it.section_title && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700" title="解析出的大题">
                    {it.section_title}
                  </span>
                )}
                {it.score != null && (
                  <span className="rounded bg-teal-100 px-1.5 py-0.5 text-teal-700">
                    {Number(it.score)} 分
                    {it.score_mode === "per_blank" ? "（每空）" : it.score_mode === "per_sub" ? "（每小问）" : ""}
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
                  {/* 可逆的一对：再点一次回到「待定」。单向的话，对一道已经跳过的题
                      就是一次静默空操作（库里的行没变、界面也没变）——正是"点了没反应"的来源 */}
                  {it.status !== "imported" && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title={skipped ? "取消「不导入」，回到待定" : "不导入这道题"}
                      onClick={() => setStatus([it.id], skipped ? "pending" : "skipped")}
                    >
                      {skipped ? (
                        <RotateCcwIcon className="size-3.5" />
                      ) : (
                        <XCircleIcon className="size-3.5" />
                      )}
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
