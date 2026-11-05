"use client"

// AI 变式题：从当前题生成同题型的客观题草稿。
//
// **只生成草稿**：生成后先过 normalizeQuestion + auditQuestion + find_similar_questions，
// 教师确认才 create_question_draft；永不自动发布，仍走两级审批。
import { useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { getDeepSeekKey, getDeepSeekModel } from "@/lib/deepseek-prefs"
import { callChat, salvageJson } from "@/lib/deepseek"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import {
  VARIANT_DIMENSIONS,
  buildVariantMessages,
  isVariantableQtype,
  validateVariantResponse,
} from "@/lib/variant-prompt"
import { normalizeQuestion } from "@/lib/import-pipeline"
import { auditQuestion } from "@/lib/question-audit"
import {
  blocksToText,
  difficultyLabel,
  qtypeLabel,
  serializeContent,
  DIFFICULTIES,
} from "@/lib/question-model"
import { AiConfigLink } from "@/components/settings/ai-config-link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2Icon, SparklesIcon, ExternalLinkIcon } from "lucide-react"

export function VariantDialog({
  open,
  onOpenChange,
  draft,
  nodes = [],
  initialResults = null,
  initialCaveats = "",
  initialWarnings = [],
}) {
  const { ready, hasKey, model, refresh } = useDeepSeekPrefs()
  const [dimensions, setDimensions] = useState(["data"])
  const [count, setCount] = useState(1)
  const [targetDifficulty, setTargetDifficulty] = useState(draft?.difficulty ?? 2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [results, setResults] = useState(initialResults)
  const [caveats, setCaveats] = useState(initialCaveats)
  const [warnings, setWarnings] = useState(initialWarnings)
  const [saved, setSaved] = useState({})

  const sourceText = blocksToText(draft?.stem ?? [])
  const variantable = isVariantableQtype(draft?.qtype)

  function toggleDimension(value) {
    setDimensions((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]
    )
  }

  async function run() {
    setError("")
    setResults(null)
    setSaved({})
    if (!variantable) {
      setError("本轮只支持单选/多选/判断/填空题；复合题与简答题后续再开")
      return
    }
    if (dimensions.length === 0) {
      setError("至少选一个变式维度")
      return
    }
    const key = getDeepSeekKey()
    if (!key) {
      setError("请先在「AI 配置」里填写密钥")
      return
    }

    setBusy(true)
    try {
      const messages = buildVariantMessages({
        qtype: draft.qtype,
        difficulty: draft.difficulty,
        content: serializeContent(draft),
        tags: draft.tags,
        dimensions,
        count,
        targetDifficulty,
      })
      const modelName = getDeepSeekModel() || model || undefined
      let check = null
      let lastReason = ""
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
        const res = await callChat({
          messages,
          apiKey: key,
          model: modelName,
          maxTokens: 3000,
          temperature: 0.8,
        })
        check = validateVariantResponse(salvageJson(res.content))
        if (check.ok) break
        lastReason = res.finishReason === "length" ? "输出被截断" : check.reason
      }
      if (!check?.ok) {
        setError(`模型连续 3 次没有按格式返回（${lastReason}）`)
        return
      }

      const supabase = createClient()
      const prepared = []
      for (const raw of check.questions) {
        const normalized = normalizeQuestion(raw, {
          defaultQtype: draft.qtype,
          defaultDifficulty: targetDifficulty,
          genAnalysis: true,
        })
        if (!normalized) {
          prepared.push({ invalidReason: "结构不完整，无法生成草稿", note: raw?.variant_note ?? "" })
          continue
        }
        if (normalized.qtype !== draft.qtype) {
          prepared.push({
            invalidReason: `题型不一致（${qtypeLabel(normalized.qtype)}），本轮只生成同题型`,
            note: raw?.variant_note ?? "",
          })
          continue
        }
        const audit = auditQuestion({
          qtype: normalized.qtype,
          difficulty: normalized.difficulty,
          content: normalized.content,
          tags: draft.tags,
        })
        let similar = []
        try {
          const { data } = await supabase.rpc("find_similar_questions", {
            p_content: { stem: normalized.content?.stem },
          })
          similar = data ?? []
        } catch {
          // 查重失败静默：它只是评审辅助，不挡生成
        }
        prepared.push({
          qtype: normalized.qtype,
          difficulty: normalized.difficulty,
          content: normalized.content,
          issues: audit.issues,
          similar,
          note: raw?.variant_note ?? "",
        })
      }
      setResults(prepared)
      setCaveats(check.caveats)
      setWarnings(check.warnings)
    } catch (err) {
      setError(err.message || "生成失败")
    } finally {
      setBusy(false)
    }
  }

  async function save(index) {
    const result = results?.[index]
    if (!result || result.invalidReason) return
    if ((result.issues ?? []).some((issue) => issue.severity === "error")) {
      toast.error("先修正规则错误，再存草稿")
      return
    }
    if (!draft?.nodeId) {
      toast.error("先给原题选科目节点，变式题才能落草稿")
      return
    }
    setBusy(true)
    try {
      const supabase = createClient()
      const { data: versionId, error: saveError } = await supabase.rpc(
        "create_question_draft",
        {
          p_course_node: draft.nodeId,
          p_qtype: result.qtype,
          p_difficulty: result.difficulty,
          p_content: result.content,
          p_tag_ids: (draft.tags ?? []).map((tag) => tag.id),
        }
      )
      if (saveError) throw new Error(saveError.message)
      // AI 标记是辅助信息：迁移未执行时草稿仍然保存，只提示一句，不挡流程。
      const { error: markError } = await supabase.rpc(
        "mark_question_draft_ai_generated",
        { p_version_id: versionId }
      )
      if (markError) {
        toast.warning("草稿已保存；AI 标记未写上（0132 迁移是否已执行？）")
      }
      // 草稿已创建；题目 id 只用于给一个“去编辑器”的链接，取不到不影响已保存的事实。
      const { data: row } = await supabase
        .from("question_versions")
        .select("question_id")
        .eq("id", versionId)
        .single()
      setSaved((prev) => ({
        ...prev,
        [index]: { versionId, questionId: row?.question_id ?? null },
      }))
      toast.success("已存为草稿（未发布），请去编辑器核对")
    } catch (err) {
      toast.error(err.message || "存草稿失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4" /> AI 变式题
          </DialogTitle>
          <DialogDescription>
            从当前题生成同题型的客观题草稿；生成后先做规则检查与查重，教师确认才存草稿。
            不会自动发布，仍走两级审批。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
          <div className="rounded-lg border bg-muted/20 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="font-normal">
                {qtypeLabel(draft?.qtype)}
              </Badge>
              <Badge variant="outline" className="font-normal">
                {difficultyLabel(draft?.difficulty)}难度
              </Badge>
              {draft?.tags?.map((tag) => (
                <Badge key={tag.id} variant="outline" className="font-normal">
                  {tag.name}
                </Badge>
              ))}
            </div>
            <p className="mt-1 line-clamp-2 text-muted-foreground">{sourceText || "（题干为空）"}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">变式维度</span>
            {VARIANT_DIMENSIONS.map((item) => (
              <Button
                key={item.value}
                type="button"
                size="sm"
                variant={dimensions.includes(item.value) ? "secondary" : "outline"}
                onClick={() => toggleDimension(item.value)}
              >
                {item.label}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 text-xs">
              数量
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="h-8 rounded-md border bg-transparent px-2"
              >
                {[1, 2, 3].map((value) => (
                  <option key={value} value={value}>
                    {value} 道
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs">
              目标难度
              <select
                value={targetDifficulty}
                onChange={(e) => setTargetDifficulty(Number(e.target.value))}
                className="h-8 rounded-md border bg-transparent px-2"
              >
                {DIFFICULTIES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" size="sm" onClick={run} disabled={busy || !ready || !variantable}>
              {busy ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <SparklesIcon className="size-3.5" />
              )}
              生成变式
            </Button>
            {!hasKey && <AiConfigLink compact onChange={refresh} />}
          </div>

          {!variantable && (
            <p className="text-xs text-amber-700">
              当前题型是 {qtypeLabel(draft?.qtype)}：本轮只开单选/多选/判断/填空。
            </p>
          )}
          {error && <p className="text-xs text-rose-600">{error}</p>}

          {results && (
            <div className="space-y-2">
              {results.map((result, index) => (
                <VariantCard
                  key={index}
                  result={result}
                  index={index}
                  saved={saved[index]}
                  busy={busy}
                  onSave={() => save(index)}
                />
              ))}
              {caveats && <p className="text-xs text-muted-foreground">{caveats}</p>}
              {warnings?.length > 0 && (
                <ul className="text-xs text-amber-700">
                  {warnings.map((warning, index) => (
                    <li key={index}>· {warning}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function VariantCard({ result, index, saved, busy, onSave }) {
  if (result.invalidReason) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-sm text-rose-800">
        变式 {index + 1}：{result.invalidReason}
        {result.note && <p className="mt-1 text-xs">模型说明：{result.note}</p>}
      </div>
    )
  }

  const issues = result.issues ?? []
  const hasError = issues.some((issue) => issue.severity === "error")
  const similar = (result.similar ?? []).slice(0, 3)

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">变式 {index + 1}</span>
        <Badge variant="secondary" className="font-normal">
          {qtypeLabel(result.qtype)}
        </Badge>
        <Badge variant="outline" className="font-normal">
          {difficultyLabel(result.difficulty)}难度
        </Badge>
        {saved ? (
          <Badge variant="secondary" className="ml-auto font-normal">
            已存草稿
          </Badge>
        ) : (
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            onClick={onSave}
            disabled={busy || hasError}
            title={hasError ? "先修正规则错误" : undefined}
          >
            存为草稿
          </Button>
        )}
      </div>

      {result.note && <p className="mt-1 text-xs text-muted-foreground">变式说明：{result.note}</p>}
      <p className="mt-1">{blocksToText(result.content?.stem)}</p>
      {result.content?.options?.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {result.content.options.map((option) => (
            <li key={option.key}>
              {option.key}. {blocksToText(option.label)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        答案：{JSON.stringify(result.content?.answer)}
      </p>
      {result.content?.analysis?.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          解析：{blocksToText(result.content.analysis)}
        </p>
      )}

      {issues.length > 0 ? (
        <ul className="mt-2 rounded-md border border-amber-300 bg-amber-50/70 p-2 text-xs text-amber-900">
          {issues.slice(0, 5).map((issue, issueIndex) => (
            <li key={issueIndex}>
              · [{issue.severity}] {issue.category}：{issue.problem}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-emerald-700">规则检查通过</p>
      )}

      {similar.length > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          <p>题库相似题：</p>
          <ul>
            {similar.map((item, similarIndex) => (
              <li key={similarIndex}>
                · {Math.round((item.similarity ?? 0) * 100)}% {String(item.stem ?? "").slice(0, 40)}…
              </li>
            ))}
          </ul>
        </div>
      )}

      {saved?.questionId && (
        <a
          href={`/questions/${saved.questionId}/edit`}
          className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          去编辑器核对 <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </div>
  )
}
