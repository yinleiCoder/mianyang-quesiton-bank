"use client"

// 智能组卷弹窗：收约束 → 调只读候选 RPC → 本地贪心 + 模拟退火 → 预览/换题 → 应用到卷面。
//
// 设计取舍：
//   · 组卷算法完全在浏览器里跑，不走大模型、不产生调用费用；
//   · 服务端只提供紧凑候选特征（无题干全文/选项/答案），选中后才按 version_id 取 content；
//   · “应用”只 dispatch 到编辑器，不直接写库；保存仍走原来的 save_paper_draft。
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { loadPaperAiCandidates, loadVersionRows } from "@/lib/paper-candidates"
import { optimizePaperPlan, swapPlanItem } from "@/lib/paper-optimizer"
import { itemFromBank } from "@/lib/paper-editor-state"
import { QTYPES } from "@/lib/question-model"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { PaperAiPlanPreview } from "@/components/papers/paper-ai-plan-preview"
import { PaperIntentPanel } from "@/components/papers/paper-intent-panel"
import { intentToRows } from "@/lib/paper-intent-prompt"
import { Loader2Icon, SparklesIcon } from "lucide-react"

const BAND_LABELS = ["易", "中", "难"]
const DEFAULT_MIX = { 1: 30, 2: 50, 3: 20 }

function newKey() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `s_${Date.now()}_${Math.random()}`
}

function initialRows(defaultSections) {
  const base = (defaultSections ?? []).filter((section) => (section.items ?? []).length > 0)
  if (base.length === 0) {
    return [
      {
        key: "s0",
        title: "单项选择题",
        qtype: "single_choice",
        count: 10,
        score_mode: "per_item",
        score_each: 3,
        mix: { ...DEFAULT_MIX },
      },
    ]
  }
  return base.map((section, index) => ({
    key: section.key ?? `s${index}`,
    title: section.title ?? "",
    qtype: section.items[0]?.qtype ?? "single_choice",
    count: section.items.length,
    score_mode: section.score_mode ?? "per_item",
    score_each: Number(section.score_each) || 0,
    mix: { ...DEFAULT_MIX },
  }))
}

function buildSpec(rows, { courseNodeId, targetScore, excludeRecent, requestedTags = [] }) {
  return {
    node_id: courseNodeId ?? null,
    exclude_recent_days: Number(excludeRecent) || 0,
    limit: 800,
    requested_tag_ids: (requestedTags ?? []).map((tag) => tag.id),
    target_score: targetScore === "" ? null : Number(targetScore),
    sections: rows.map((row) => ({
      key: row.key,
      title: row.title,
      qtype: row.qtype,
      count: Number(row.count) || 0,
      score_mode: row.score_mode,
      score_each: Number(row.score_each) || 0,
      difficulty_mix: {
        1: (Number(row.mix[1]) || 0) / 100,
        2: (Number(row.mix[2]) || 0) / 100,
        3: (Number(row.mix[3]) || 0) / 100,
      },
      ...(row.max_per_tag ? { max_per_tag: Number(row.max_per_tag) } : {}),
    })),
  }
}

export function PaperAiPlanner({
  open,
  onOpenChange,
  courseNodeId,
  courseNodeName = null,
  nodes = [],
  defaultSections,
  initialTarget,
  onApply,
}) {
  const [rows, setRows] = useState(() => initialRows(defaultSections))
  const [targetScore, setTargetScore] = useState(initialTarget == null ? "" : String(initialTarget))
  const [excludeRecent, setExcludeRecent] = useState(90)
  const [requestedTags, setRequestedTags] = useState([])
  const [applyMode, setApplyMode] = useState("replace")
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState("")

  // 每次打开都按“当前卷面”重新播种。defaultSections 每次渲染都是新数组，
  // 不能进依赖，否则输入一个字就会把用户填的约束冲掉。
  useEffect(() => {
    if (!open) return
    setRows(initialRows(defaultSections))
    setTargetScore(initialTarget == null ? "" : String(initialTarget))
    setRequestedTags([])
    setPlan(null)
    setError("")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const patchRow = (index, patch) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const patchMix = (index, band, value) =>
    setRows((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, mix: { ...row.mix, [band]: Number(value) || 0 } } : row
      )
    )

  async function generate(seed = Math.floor(Math.random() * 1e9)) {
    setBusy(true)
    setError("")
    setPlan(null)
    try {
      const spec = buildSpec(rows, { courseNodeId, targetScore, excludeRecent, requestedTags })
      const supabase = createClient()
      const { data, error: loadError } = await loadPaperAiCandidates(supabase, spec)
      if (loadError) throw new Error(loadError.message)
      const candidates = data?.items ?? []
      if (candidates.length === 0) throw new Error("当前科目节点下没有可用题目")
      const result = optimizePaperPlan(spec, candidates, { seed, iterations: 4000 })
      setPlan({ ...result, spec, candidates })
      if (!result.feasible) toast.warning("候选不足，方案不完整；可减少题数或放宽条件")
    } catch (e) {
      setError(e.message || "生成失败")
      toast.error(e.message || "生成失败")
    } finally {
      setBusy(false)
    }
  }

  // 一句话解析结果只改表单，不自动生成；教师确认后再点「生成方案」。
  function applyIntent(intent, { tags = [] } = {}) {
    const nextRows = intentToRows(intent)
    if (nextRows.length === 0) {
      toast.warning("还没有解析出大题结构，先补充信息")
      return
    }
    setRows(nextRows)
    setTargetScore(intent.target_score == null ? "" : String(intent.target_score))
    setExcludeRecent(intent.exclude_recent_days ?? 90)
    setRequestedTags(tags)
    setPlan(null)
    setError("")
    toast.success("已套用到表单；确认后点「生成方案」")
  }

  function swap(sectionIndex, itemIndex) {
    if (!plan) return
    const next = swapPlanItem(plan, sectionIndex, itemIndex, plan.spec, plan.candidates, {
      seed: (plan.seed ?? 0) + 1,
    })
    setPlan({ ...plan, ...next, spec: plan.spec, candidates: plan.candidates })
  }

  async function apply() {
    if (!plan?.feasible) return
    setBusy(true)
    try {
      const versionIds = plan.sections.flatMap((section) =>
        section.items.map((item) => item.version_id)
      )
      const supabase = createClient()
      const { data: rowsData, error: loadError } = await loadVersionRows(supabase, versionIds)
      if (loadError) throw new Error(loadError.message)
      const byVersion = new Map((rowsData ?? []).map((row) => [row.id, row]))
      let missing = 0
      const sections = plan.sections
        .map((section) => ({
          ...section,
          items: section.items
            .map((item) => {
              const row = byVersion.get(item.version_id)
              if (!row) missing += 1
              return row ? itemFromBank(row) : null
            })
            .filter(Boolean),
        }))
        .filter((section) => section.items.length > 0)
      if (missing > 0) toast.warning(`${missing} 道题已不可用，已从方案中跳过`)
      if (sections.length === 0) throw new Error("方案里的题都已不可用，请重新生成")
      onApply({
        sections,
        mode: applyMode,
        meta:
          applyMode === "replace" ? { target_score: plan.metrics.total_score } : null,
      })
    } catch (e) {
      toast.error(e.message || "应用失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4" /> 智能组卷（约束优化）
          </DialogTitle>
          <DialogDescription>
            可以直接在上面说一句话，也可以手填下面的表单；难度用真实作答校准，最近用过的题会被降权。
            生成结果只是草稿，保存仍由你确认。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
          <PaperIntentPanel
            courseNodeId={courseNodeId}
            courseNodeName={courseNodeName}
            nodes={nodes}
            currentTarget={targetScore === "" ? null : Number(targetScore)}
            currentSections={rows.map((row) => ({
              title: row.title,
              qtype: row.qtype,
              count: Number(row.count) || 0,
            }))}
            onApplyIntent={applyIntent}
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="ai-exclude">排除最近使用（天）</Label>
              <Input
                id="ai-exclude"
                type="number"
                min="0"
                max="3650"
                value={excludeRecent}
                onChange={(e) => setExcludeRecent(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="ai-target">目标总分（可空）</Label>
              <Input
                id="ai-target"
                type="number"
                min="0"
                step="0.5"
                value={targetScore}
                onChange={(e) => setTargetScore(e.target.value)}
                className="mt-1"
                placeholder="留空 = 不约束总分"
              />
            </div>
            <div>
              <Label htmlFor="ai-apply-mode">应用到卷面</Label>
              <select
                id="ai-apply-mode"
                value={applyMode}
                onChange={(e) => setApplyMode(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              >
                <option value="replace">替换整卷</option>
                <option value="append">追加到大题</option>
              </select>
            </div>
          </div>

          {requestedTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/30 p-2 text-xs">
              <span className="text-muted-foreground">优先覆盖标签：</span>
              {requestedTags.map((tag) => (
                <Badge key={tag.id} variant="secondary" className="gap-1 font-normal">
                  {tag.name}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setRequestedTags((prev) => prev.filter((item) => item.id !== tag.id))
                    }
                    aria-label={`移除标签 ${tag.name}`}
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {rows.map((row, index) => (
              <div key={row.key} className="rounded-lg border p-3">
                <div className="grid gap-2 sm:grid-cols-6">
                  <div className="sm:col-span-2">
                    <Label>大题标题</Label>
                    <Input
                      value={row.title}
                      onChange={(e) => patchRow(index, { title: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>题型</Label>
                    <select
                      value={row.qtype}
                      onChange={(e) => patchRow(index, { qtype: e.target.value })}
                      className="mt-1 h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                    >
                      {QTYPES.map((qtype) => (
                        <option key={qtype.value} value={qtype.value}>
                          {qtype.short ?? qtype.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label>题数</Label>
                    <Input
                      type="number"
                      min="1"
                      max="200"
                      value={row.count}
                      onChange={(e) => patchRow(index, { count: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>计分口径</Label>
                    <select
                      value={row.score_mode}
                      onChange={(e) => patchRow(index, { score_mode: e.target.value })}
                      className="mt-1 h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                    >
                      <option value="per_item">每题</option>
                      <option value="per_blank">每空</option>
                      <option value="per_sub">每小问</option>
                    </select>
                  </div>
                  <div>
                    <Label>每题/空分值</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.5"
                      value={row.score_each}
                      onChange={(e) => patchRow(index, { score_each: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-end gap-3">
                  <span className="text-xs text-muted-foreground">难度配比</span>
                  {[1, 2, 3].map((band) => (
                    <label key={band} className="flex items-center gap-1 text-xs">
                      {BAND_LABELS[band - 1]}
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        value={row.mix[band]}
                        onChange={(e) => patchMix(index, band, e.target.value)}
                        className="h-8 w-16"
                      />
                      %
                    </label>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={rows.length <= 1}
                    onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setRows((prev) => [
                  ...prev,
                  {
                    key: newKey(),
                    title: "新大题",
                    qtype: "single_choice",
                    count: 5,
                    score_mode: "per_item",
                    score_each: 2,
                    mix: { ...DEFAULT_MIX },
                  },
                ])
              }
            >
              添加大题
            </Button>
          </div>

          {error && <p className="text-sm text-rose-600">{error}</p>}
          {plan && <PaperAiPlanPreview plan={plan} busy={busy} onSwap={swap} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => generate()} disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SparklesIcon className="size-4" />}
            {plan ? "换一批" : "生成方案"}
          </Button>
          <Button type="button" onClick={apply} disabled={busy || !plan?.feasible}>
            应用到卷面
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
