"use client"

// 审题预检面板：规则检查永远可用，AI 复审是可选的加分项（教师自己的密钥）。
//
// 设计取舍：
//   · 规则与落库校验同源（lib/question-audit.js 内部复用 validateContent），
//     不会出现"预检说没问题、保存却被拒"；
//   · AI 只输出建议，绝不自动改题/自动退回；退回意见由人点「填入」才写进对话框；
//   · 没有密钥时仍显示完整规则结果，AI 按钮只是提示去配置。
import { useEffect, useMemo, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { auditQuestion } from "@/lib/question-audit"
import { buildQuestionAuditMessages, validateQuestionAudit } from "@/lib/question-audit-prompt"
import { callChat, salvageJson } from "@/lib/deepseek"
import { getDeepSeekKey } from "@/lib/deepseek-prefs"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { blocksToText, serializeContent } from "@/lib/question-model"
import { AiConfigLink } from "@/components/settings/ai-config-link"
import { DecisionCard } from "@/components/ai/decision-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ClipboardCopyIcon, Loader2Icon, SparklesIcon } from "lucide-react"

const VERDICT = {
  pass: { label: "通过", cls: "bg-emerald-100 text-emerald-700" },
  revise: { label: "建议修改", cls: "bg-amber-100 text-amber-700" },
  reject: { label: "建议退回", cls: "bg-rose-100 text-rose-700" },
}

const SEVERITY = {
  error: { label: "错误", cls: "bg-rose-100 text-rose-700" },
  warn: { label: "建议", cls: "bg-amber-100 text-amber-700" },
  info: { label: "提示", cls: "bg-sky-100 text-sky-700" },
}

function IssueList({ issues, empty }) {
  if (!issues?.length) {
    return <p className="text-xs text-muted-foreground">{empty}</p>
  }
  return (
    <ul className="space-y-1.5">
      {issues.map((item, index) => {
        const severity = SEVERITY[item.severity] ?? SEVERITY.info
        return (
          <li key={`${item.category}-${index}`} className="rounded-md border px-2 py-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className={`font-normal ${severity.cls}`}>{severity.label}</Badge>
              <span className="font-medium">{item.category}</span>
              <span>{item.problem}</span>
            </div>
            {item.suggestion && <p className="mt-0.5 text-muted-foreground">建议：{item.suggestion}</p>}
            {item.evidence && <p className="mt-0.5 text-muted-foreground">依据：{item.evidence}</p>}
          </li>
        )
      })}
    </ul>
  )
}

export function QuestionAuditPanel({
  draft = null,
  content = null,
  qtype,
  difficulty,
  tags = [],
  hasNode,
  questionId = null,
  similar = [],
  mode = "author",
  onFillComment,
}) {
  const { ready, hasKey, model, refresh } = useDeepSeekPrefs()
  const [accuracy, setAccuracy] = useState(null)
  const [ai, setAi] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState("")

  // 编辑既有题/审核时才有 question_id；新题没有经验数据可查。
  useEffect(() => {
    if (!questionId) return
    let cancelled = false
    const supabase = createClient()
    supabase
      .rpc("question_accuracy", { p_question_ids: [questionId] })
      .then(({ data }) => {
        if (!cancelled) setAccuracy(data?.[0] ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [questionId])

  const local = useMemo(
    () => auditQuestion({ draft, content, qtype, difficulty, tags, hasNode, similar, accuracy }),
    [draft, content, qtype, difficulty, tags, hasNode, similar, accuracy]
  )

  async function runAi() {
    const key = getDeepSeekKey()
    if (!key) {
      setShowSettings(true)
      return
    }
    setAiBusy(true)
    setAiError("")
    try {
      const payloadContent = content ?? (draft ? serializeContent(draft) : null)
      if (!payloadContent) throw new Error("题目内容还没填完，无法复审")
      const messages = buildQuestionAuditMessages({
        qtype: qtype ?? draft?.qtype,
        difficulty: difficulty ?? draft?.difficulty,
        content: payloadContent,
        tags,
        accuracy,
        similar,
      })
      let check = null
      let lastReason = ""
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
        const res = await callChat({ messages, apiKey: key, model, maxTokens: 3000, temperature: 0.7 })
        check = validateQuestionAudit(salvageJson(res.content))
        if (check.ok) break
        lastReason = res.finishReason === "length" ? "输出被截断" : check.reason
      }
      if (!check?.ok) {
        setAiError(`模型连续 3 次没有按格式返回（${lastReason}）`)
        return
      }
      setAi(check.audit)
    } catch (error) {
      setAiError(error.message || "AI 复审失败")
    } finally {
      setAiBusy(false)
    }
  }

  function fillComment() {
    const all = [...local.issues, ...(ai?.issues ?? [])].filter(
      (item) => item.severity !== "info"
    )
    if (all.length === 0) {
      onFillComment?.("审题预检未发现必须修改的问题。")
      return
    }
    onFillComment?.(
      all
        .map(
          (item) =>
            `· ${item.category}：${item.problem}${item.suggestion ? `（建议：${item.suggestion}）` : ""}`
        )
        .join("\n")
    )
  }

  const verdict = VERDICT[local.verdict] ?? VERDICT.revise
  const aiVerdict = ai ? VERDICT[ai.verdict] ?? VERDICT.revise : null
  const currentContent = content ?? (draft ? serializeContent(draft) : null)
  const stemText = blocksToText(currentContent?.stem).trim()

  // 空表单不甩一堆红字：开始填题干之后再实时检查。
  if (!stemText) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground sm:p-5">
          <span className="font-medium text-foreground">审题预检</span>
          <span>
            {" "}
            · 开始填写题干后，这里会实时检查规范性、查重与经验难度；AI 复审只给建议，不自动改题。
          </span>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">审题预检</h3>
          <Badge className="font-normal">
            {local.grade} · {local.score}
          </Badge>
          <Badge className={`font-normal ${verdict.cls}`}>{verdict.label}</Badge>
          <span className="text-xs text-muted-foreground">
            {local.stats.errors} 错误 · {local.stats.warnings} 建议 · {local.stats.infos} 提示
          </span>
        </div>

        <IssueList issues={local.issues} empty="规则检查未发现问题。" />

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={runAi} disabled={aiBusy || !ready}>
            {aiBusy ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
            AI 复审
          </Button>
          {!hasKey && <AiConfigLink compact onChange={refresh} />}
          {mode === "review" && onFillComment && (
            <Button type="button" size="sm" variant="secondary" onClick={fillComment}>
              <ClipboardCopyIcon className="size-3.5" /> 填入退回意见
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            规则检查永远可用；AI 复审用你自己的密钥，只给建议，不自动改题。
          </span>
        </div>

        {aiError && <p className="text-xs text-rose-600">{aiError}</p>}

        {ai && aiVerdict && (
          <DecisionCard
            title="AI 复审"
            method="LLM 六维复审 + 规则检查"
            decision={`${aiVerdict.label} · 得分 ${ai.score}`}
            inputs={[
              `规则问题 ${local.stats.errors + local.stats.warnings} 条`,
              `AI 问题 ${ai.issues.length} 条`,
            ]}
            caveats={ai.caveats}
          >
            <IssueList issues={ai.issues} empty="AI 没有发现额外问题。" />
            {ai.rewrite_hint && (
              <p className="text-xs text-muted-foreground">重写方向：{ai.rewrite_hint}</p>
            )}
          </DecisionCard>
        )}
      </CardContent>
    </Card>
  )
}
