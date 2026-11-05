"use client"

// 阅卷台的 AI 建议评分（pending 的人工题：简答、填空、综合）。
//
// **只填不写**：采纳建议只改 GradeRow 的 units/comment 输入框，
// 真正的落库仍是教师点「保存本题给分」→ grade_exam_answer。
// 空白作答不走模型，直接给 0 分建议（省一次调用，也避免"没写却给分"）。
import { useState } from "react"
import { getDeepSeekKey, getDeepSeekModel } from "@/lib/deepseek-prefs"
import { callChat, salvageJson } from "@/lib/deepseek"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { buildGradingMessages, validateGradingSuggestion } from "@/lib/grading-prompt"
import { buildUnitSpecs } from "@/lib/grading-units"
import { blocksToText } from "@/lib/question-model"
import { round2 } from "@/lib/paper-units"
import { AiConfigLink } from "@/components/settings/ai-config-link"
import { DecisionCard } from "@/components/ai/decision-card"
import { Button } from "@/components/ui/button"
import { Loader2Icon, SparklesIcon } from "lucide-react"

export function AiGradeSuggest({
  item,
  record,
  labels = [],
  onApply,
  initialSuggestion = null,
}) {
  const { ready, hasKey, model, refresh } = useDeepSeekPrefs()
  const [suggestion, setSuggestion] = useState(initialSuggestion)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const specs = buildUnitSpecs(item, record, labels)
  const maxUnits = specs.map((unit) => unit.max)
  const totalScore = round2(maxUnits.reduce((sum, value) => sum + value, 0))
  const studentAnswer = specs.map((unit) => unit.student).join("\n")
  const blank = specs.length > 0 && specs.every((unit) => unit.blank)
  const total = suggestion
    ? round2(suggestion.units.reduce((sum, unit) => sum + unit.score, 0))
    : 0

  async function run() {
    setError("")
    if (blank) {
      setSuggestion({
        units: maxUnits.map((max, index) => ({
          index,
          score: 0,
          max,
          reason: "未作答",
          evidence: "",
        })),
        confidence: 1,
        comment: "本题未作答。",
        missing_points: [],
        caveats: "未作答，按 0 分处理。",
      })
      return
    }
    const key = getDeepSeekKey()
    if (!key) {
      setError("请先在「AI 配置」里填写密钥")
      return
    }
    setBusy(true)
    try {
      const messages = buildGradingMessages({
        qtype: item.qtype,
        stem: blocksToText(item.content?.stem),
        analysis: blocksToText(item.content?.analysis),
        unitSpecs: specs,
        totalScore,
        studentAnswer,
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
          maxTokens: 2000,
          temperature: 0.7,
        })
        check = validateGradingSuggestion(salvageJson(res.content), {
          maxUnits,
          totalScore,
          blank,
          unitSpecs: specs,
        })
        if (check.ok) break
        lastReason = res.finishReason === "length" ? "输出被截断" : check.reason
      }
      if (!check?.ok) {
        setError(`模型连续 3 次没有按格式返回（${lastReason}）`)
        return
      }
      setSuggestion(check.suggestion)
    } catch (err) {
      setError(err.message || "AI 建议失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 rounded-lg border bg-muted/30 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={run}
          disabled={busy || !ready}
        >
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <SparklesIcon className="size-3.5" />
          )}
          AI 建议评分
        </Button>
        {!hasKey && <AiConfigLink compact onChange={refresh} />}
        <span className="text-xs text-muted-foreground">
          只填建议分，保存仍由你点「保存本题给分」
        </span>
      </div>

      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}

      {suggestion && (
        <div className="mt-2">
          <DecisionCard
            title="AI 建议评分"
            method="LLM + 评分点校验"
            decision={`${total} / ${totalScore} 分`}
            inputs={["学生作答", `${suggestion.units.length} 个评分点`]}
            factors={suggestion.units.map((unit) => ({
              label: labels[unit.index] ?? `第 ${unit.index + 1} 点`,
              value: `${unit.score} / ${unit.max}`,
              hint: unit.reason,
            }))}
            confidence={suggestion.confidence}
            caveats={suggestion.caveats}
            actions={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  onApply?.(
                    suggestion.units.map((unit) => unit.score),
                    suggestion.comment
                  )
                }
              >
                采纳建议
              </Button>
            }
          >
            <ul className="space-y-1 text-xs">
              {suggestion.units.map((unit) => (
                <li key={unit.index} className="rounded border bg-background/70 px-2 py-1">
                  <span className="font-medium">
                    {labels[unit.index] ?? `第 ${unit.index + 1} 点`}依据
                  </span>
                  <span className="ml-1 text-muted-foreground">
                    {unit.evidence || "无原文依据"}
                  </span>
                </li>
              ))}
            </ul>
            {suggestion.missing_points.length > 0 && (
              <p className="text-xs text-muted-foreground">
                漏掉的要点：{suggestion.missing_points.join("；")}
              </p>
            )}
            {suggestion.comment && (
              <p className="text-xs text-muted-foreground">建议评语：{suggestion.comment}</p>
            )}
          </DecisionCard>
        </div>
      )}
    </div>
  )
}
