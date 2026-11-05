"use client"

// 讲评教案面板：模板兜底（无密钥也能用）+ 可选 AI 精修（教师自己的密钥）。
//
// 数据链：页面已经拿到了 class_ai_report（含报告内容、当前指纹、stale）；
// 教案本身由 class_lesson_plan 读、save_class_lesson_plan 写，指纹同时绑定
// 当前 payload 与报告指纹 —— 成绩或报告一变，旧教案就会被标成 stale。
//
// 报告本身过期（initial.stale）时**禁止生成**：拿一份对不上现在学情的报告去排教案，
// 比不生成更糟。用户要先在上面的 AI 分析里重新生成。
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { getDeepSeekKey, getDeepSeekModel } from "@/lib/deepseek-prefs"
import { callChat, salvageJson } from "@/lib/deepseek"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { loadClassLessonPlan, saveClassLessonPlan } from "@/lib/lesson-plan"
import { buildFallbackLessonPlan } from "@/lib/lesson-plan-fallback"
import {
  buildLessonPlanMessages,
  collectReportSeqs,
  validateLessonPlan,
} from "@/lib/lesson-plan-prompt"
import { AiConfigLink } from "@/components/settings/ai-config-link"
import { LessonPlanView } from "@/components/classes/lesson-plan-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { FileTextIcon, Loader2Icon, PrinterIcon, SparklesIcon } from "lucide-react"

const DURATION = 45

export function LessonPlanPanel({ paperId, classId, initial }) {
  const { ready, hasKey, refresh } = useDeepSeekPrefs()
  const [saved, setSaved] = useState(null)
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  const report = initial?.report?.content ?? null
  const reportStale = Boolean(initial?.stale)
  const reportMissing = !report

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, denied, error: loadError } = await loadClassLessonPlan(
          createClient(),
          { paperId, classId }
        )
        if (cancelled) return
        if (denied) {
          setError("没有权限查看这个班级的教案")
          return
        }
        if (loadError) {
          setError(loadError.message || "加载教案失败")
          return
        }
        setSaved(data)
        setPlan(data?.plan ?? null)
      } catch (err) {
        if (!cancelled) setError(err.message || "加载教案失败")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [paperId, classId, initial?.fingerprint, initial?.stale])

  async function persist(nextPlan, modelName) {
    if (!saved?.fingerprint) {
      setError("还没有拿到当前数据指纹，请刷新页面")
      return false
    }
    const result = await saveClassLessonPlan(createClient(), {
      paperId,
      classId,
      fingerprint: saved.fingerprint,
      content: nextPlan,
      model: modelName,
    })
    if (result.stale) {
      setError("成绩或报告在生成期间变了，请刷新页面后重试")
      return false
    }
    if (result.denied) {
      setError("没有权限保存这个班级的教案")
      return false
    }
    if (result.error) {
      setError(result.error.message || "保存失败")
      return false
    }
    setPlan(nextPlan)
    return true
  }

  async function generateTemplate() {
    if (!report || reportStale) return
    setBusy("template")
    setError("")
    try {
      const next = buildFallbackLessonPlan({
        report,
        paper: initial?.paper,
        classInfo: initial?.class,
        summary: initial?.summary,
        durationMinutes: DURATION,
      })
      if (await persist(next, null)) toast.success("模板教案已生成并保存")
    } catch (err) {
      setError(err.message || "生成失败")
    } finally {
      setBusy("")
    }
  }

  async function generateAi() {
    if (!report || reportStale) return
    const key = getDeepSeekKey()
    if (!key) {
      setShowSettings(true)
      return
    }
    setBusy("ai")
    setError("")
    const modelName = getDeepSeekModel()
    try {
      const messages = buildLessonPlanMessages({
        report,
        paper: initial?.paper,
        classInfo: initial?.class,
        summary: initial?.summary,
        durationMinutes: DURATION,
      })
      const seqs = collectReportSeqs(report)
      let check = null
      let lastReason = ""
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
        const res = await callChat({
          messages,
          apiKey: key,
          model: modelName,
          maxTokens: 6000,
          temperature: 0.7,
        })
        check = validateLessonPlan(salvageJson(res.content), {
          durationMinutes: DURATION,
          seqs,
        })
        if (check.ok) break
        lastReason = res.finishReason === "length" ? "输出被截断" : check.reason
      }
      if (!check?.ok) {
        setError(`模型连续 3 次没有按格式返回（${lastReason}）`)
        return
      }
      if (await persist(check.plan, modelName || "deepseek")) {
        toast.success("AI 教案已生成并保存")
      }
    } catch (err) {
      setError(err.message || "AI 生成失败")
    } finally {
      setBusy("")
    }
  }

  const disabled = busy !== "" || !saved?.fingerprint || reportMissing || reportStale

  return (
    <Card>
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">讲评教案</h3>
          {plan && (
            <Badge variant="secondary">
              {plan.meta?.source === "ai" ? "AI 精修" : "模板"}
            </Badge>
          )}
          {saved?.stale && (
            <Badge className="bg-amber-100 font-normal text-amber-700">数据已变</Badge>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            45 分钟 · 模板无需密钥，AI 精修可选
          </span>
        </div>

        {reportMissing ? (
          <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
            先生成上面的 AI 分析，再生成讲评教案。
          </p>
        ) : reportStale ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            AI 分析对应的成绩数据已经变了，请先重新生成分析，再生成教案。
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={generateTemplate}
            disabled={disabled || busy === "template"}
          >
            {busy === "template" ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <FileTextIcon className="size-3.5" />
            )}
            生成教案（模板）
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={generateAi}
            disabled={disabled || busy === "ai" || !ready}
          >
            {busy === "ai" ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
            AI 精修
          </Button>
          {!hasKey && <AiConfigLink compact onChange={refresh} />}
          {plan && (
            <Button type="button" size="sm" variant="ghost" onClick={() => window.print()}>
              <PrinterIcon className="size-3.5" /> 打印
            </Button>
          )}
        </div>

        {error && <p className="text-xs text-rose-600">{error}</p>}
        {saved?.stale && !reportStale && (
          <p className="text-xs text-amber-700">
            保存的教案对应的是旧数据，建议点「生成教案（模板）」或「AI 精修」重新生成。
          </p>
        )}

        {plan ? (
          <LessonPlanView plan={plan} />
        ) : (
          <p className="text-sm text-muted-foreground">
            还没有教案。模板生成不调用模型，也不会产生费用。
          </p>
        )}
      </CardContent>
    </Card>
  )
}
