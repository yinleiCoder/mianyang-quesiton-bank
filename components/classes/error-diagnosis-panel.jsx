"use client"

// 逐题错因诊断：从选项分布 + 填空高频错答 + 样本里找原因，给教学动作。
//
// 数据来自两个只读 RPC：
//   · class_ai_payload：题干/难度/知识点/样本；
//   · paper_question_stats：选项 key/文本/计数。
// 只给建议，不改成绩；生成结果存 class_error_diagnoses（0134），按成绩指纹判断是否过期。
import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { getDeepSeekKey, getDeepSeekModel } from "@/lib/deepseek-prefs"
import { callChat, salvageJson } from "@/lib/deepseek"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { loadClassAiPayload, saveClassErrorDiagnosis } from "@/lib/class-ai"
import { loadPaperQuestionStats } from "@/lib/analytics"
import { fmtDateTime24 } from "@/lib/format"
import {
  ERROR_CODE_LABELS,
  buildErrorDiagnosisMessages,
  pickDiagnosableQuestions,
  validateErrorDiagnosis,
} from "@/lib/error-diagnosis-prompt"
import { AiConfigLink } from "@/components/settings/ai-config-link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2Icon, SparklesIcon } from "lucide-react"

export function ErrorDiagnosisPanel({
  paperId,
  classId,
  initialQuestions = null,
  initialDiagnosis = null,
  initialMeta = null,
  initialFingerprint = null,
}) {
  const { ready, hasKey, model, refresh } = useDeepSeekPrefs()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [questions, setQuestions] = useState(initialQuestions)
  const [diagnosis, setDiagnosis] = useState(initialDiagnosis)
  const [warnings, setWarnings] = useState([])
  const [meta, setMeta] = useState(initialMeta)
  const [saveNote, setSaveNote] = useState("")

  async function run() {
    setError("")
    setWarnings([])
    setSaveNote("")
    const key = getDeepSeekKey()
    if (!key) {
      setError("请先在「AI 配置」里填写密钥")
      return
    }
    setBusy(true)
    try {
      const supabase = createClient()
      const [payloadRes, statsRes] = await Promise.all([
        loadClassAiPayload(supabase, { paperId, classId }),
        loadPaperQuestionStats(supabase, { paperId, scope: "class", classId }),
      ])
      if (payloadRes.error || !payloadRes.data?.payload) {
        throw new Error(payloadRes.error?.message || "取不到班级学情数据")
      }
      if (statsRes.error) {
        throw new Error(statsRes.error.message || "取不到选项分布")
      }
      const payload = payloadRes.data.payload
      const picked = pickDiagnosableQuestions(payload, statsRes.stats)
      if (picked.length === 0) {
        setError("没有足够样本：每题至少 5 份已判分作答，且需要选项文本或填空文本")
        return
      }
      setQuestions(picked)

      const messages = buildErrorDiagnosisMessages({
        paper: payload.paper,
        classInfo: payload.class,
        questions: picked,
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
          maxTokens: 4000,
          temperature: 0.4,
        })
        check = validateErrorDiagnosis(salvageJson(res.content), { questions: picked })
        if (check.ok) break
        lastReason = res.finishReason === "length" ? "输出被截断" : check.reason
      }
      if (!check?.ok) {
        setError(`模型连续 3 次没有按格式返回（${lastReason}）`)
        return
      }
      setDiagnosis(check.diagnosis)
      setWarnings(check.warnings)

      // 保存是加分项，不影响已经生成的结果：缓存不可用时只提示未保存。
      try {
        if (!initialFingerprint) {
          setMeta(null)
          setSaveNote("诊断已生成，但未保存（缓存不可用）。")
        } else {
          const saved = await saveClassErrorDiagnosis(supabase, {
            paperId,
            classId,
            fingerprint: initialFingerprint,
            content: { diagnosis: check.diagnosis, questions: picked },
            model: modelName,
          })
          if (saved.error) {
            setMeta(null)
            setSaveNote(
              saved.stale
                ? "生成期间成绩数据有变化，本次诊断未保存，请重新生成。"
                : "诊断已生成，但未保存（缓存不可用）。"
            )
          } else {
            setMeta({
              stale: false,
              createdAt: new Date().toISOString(),
              authorName: "我",
              authorLeft: false,
            })
            setSaveNote("已保存，同科教师打开同一份。")
          }
        }
      } catch {
        setSaveNote("诊断已生成，但未保存。")
      }
    } catch (err) {
      setError(err.message || "诊断失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-base font-semibold">
            <SparklesIcon className="size-4" /> 逐题错因诊断
          </span>
          <span className="text-xs text-muted-foreground">
            从选项分布与错答样本里找原因，只给教学建议，不改成绩
          </span>
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            onClick={run}
            disabled={busy || !ready}
          >
            {busy ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
            {diagnosis ? "重新诊断" : "开始诊断"}
          </Button>
          {!hasKey && <AiConfigLink compact onChange={refresh} />}
        </div>

        {error && <p className="text-xs text-rose-600">{error}</p>}

        {meta && diagnosis && (
          <p className={`text-xs ${meta.stale ? "text-amber-700" : "text-muted-foreground"}`}>
            {meta.stale ? "成绩数据已更新，以下为上次诊断，建议重新生成。" : "已保存"}
            {meta.createdAt ? ` · ${fmtDateTime24(meta.createdAt)}` : ""}
            {meta.authorName ? ` · ${meta.authorName}` : ""}
            {meta.authorLeft ? "（作者已注销）" : ""}
          </p>
        )}

        {diagnosis && (
          <div className="space-y-3">
            {diagnosis.summary && (
              <p className="rounded-md border bg-muted/30 p-2 text-sm">{diagnosis.summary}</p>
            )}
            {diagnosis.questions.map((item) => {
              const source = (questions ?? []).find((question) => question.seq === item.seq)
              return (
                <div key={item.seq} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">第 {item.seq} 题</span>
                    <Badge variant="secondary" className="font-normal">
                      样本 {item.sample}
                    </Badge>
                    {source?.correct_rate != null && (
                      <Badge variant="outline" className="font-normal">
                        正确率 {Math.round(Number(source.correct_rate) * 100)}%
                      </Badge>
                    )}
                    {source?.node && (
                      <span className="text-xs text-muted-foreground">{source.node}</span>
                    )}
                  </div>
                  {source?.stem && (
                    <p className="mt-1 text-xs text-muted-foreground">{source.stem}</p>
                  )}

                  <ul className="mt-2 space-y-1">
                    {item.causes.map((cause, index) => (
                      <li key={index} className="rounded border px-2 py-1 text-xs">
                        <span className="font-medium">
                          {ERROR_CODE_LABELS[cause.code] ?? cause.code} ·{" "}
                          {Math.round(cause.share * 100)}%
                        </span>
                        {cause.evidence && (
                          <span className="ml-1 text-muted-foreground">依据：{cause.evidence}</span>
                        )}
                        {cause.remedy && (
                          <p className="mt-0.5 text-muted-foreground">动作：{cause.remedy}</p>
                        )}
                      </li>
                    ))}
                  </ul>

                  {item.teaching_move && (
                    <p className="mt-2 text-xs">课堂处理：{item.teaching_move}</p>
                  )}
                  {item.caveats && (
                    <p className="mt-1 text-xs text-muted-foreground">说明：{item.caveats}</p>
                  )}
                </div>
              )
            })}

            {diagnosis.caveats && (
              <p className="text-xs text-muted-foreground">整体说明：{diagnosis.caveats}</p>
            )}
            {warnings.length > 0 && (
              <ul className="rounded-md border border-amber-300 bg-amber-50/70 p-2 text-xs text-amber-900">
                {warnings.map((warning, index) => (
                  <li key={index}>· {warning}</li>
                ))}
              </ul>
            )}
            <p
              className={`text-xs ${
                saveNote && (saveNote.includes("未保存") || saveNote.includes("有变化"))
                  ? "text-amber-700"
                  : "text-muted-foreground"
              }`}
            >
              {saveNote ||
                "诊断保存在班级里，同科教师打开同一份；成绩数据变化后会提示重新生成。"}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
