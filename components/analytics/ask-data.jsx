"use client"

// 学情问数：教师说一句话 → 受控 intent → 现有只读 RPC → CSS 图/表。
//
// 不让模型写 SQL：模型只输出 {intent, params}，客户端校验后调用现有 RPC。
// 摘要由模板生成；不二次调用模型。
import { useMemo, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import {
  loadClassReport,
  loadPaperLeaderboard,
  loadPaperQuestionStats,
} from "@/lib/analytics"
import { loadPaperQuality } from "@/lib/quality"
import { loadStudentDetail } from "@/lib/students"
import {
  buildAnalyticsIntentMessages,
  buildLeaderboardRows,
  buildLeaderboardSummary,
  buildPracticeSummary,
  buildPracticeTrendRows,
  buildQuestionQualityRows,
  buildQuestionQualitySummary,
  buildQuestionStatsRows,
  buildQuestionStatsSummary,
  buildStudentDetailRows,
  buildStudentDetailSummary,
  buildStudentDetailWrongRows,
  buildWeakNodesRows,
  buildWeakNodesSummary,
  validateAnalyticsIntent,
} from "@/lib/analytics-intent"
import { getDeepSeekKey, getDeepSeekModel } from "@/lib/deepseek-prefs"
import { callChat, salvageJson } from "@/lib/deepseek"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { AiConfigLink } from "@/components/settings/ai-config-link"
import { AskDataResult } from "@/components/analytics/ask-data-result"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Loader2Icon, SparklesIcon } from "lucide-react"

const CLASS_SUGGESTIONS = [
  "最近 30 天班里哪些知识点最弱？",
  "近两周大家的练习量怎么样？",
]
const PAPER_SUGGESTIONS = [
  "这次考试哪几道题正确率最低？",
  "区分度最低的题是哪几道？",
  "成绩榜前几名是谁？",
]
const STUDENT_SUGGESTIONS = [
  "这个学生最近练得怎么样？",
  "他最弱的知识点是什么？",
  "错得最多的题是哪些？",
]

export function AskData({
  classId = null,
  className = "",
  paperId = null,
  paperTitle = "",
  studentId = null,
  scope = null,
  activeClassId = null,
  isStaff = false,
  nodes = [],
  initialResult = null,
}) {
  const { ready, hasKey, model, refresh } = useDeepSeekPrefs()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState(initialResult)

  const allowedIntents = useMemo(() => {
    const list = []
    if (classId) list.push("weak_nodes", "practice_trend")
    if (paperId) {
      list.push("question_stats", "leaderboard")
      if (isStaff) list.push("question_quality")
    }
    if (studentId) list.push("student_detail")
    return list
  }, [classId, paperId, studentId, isStaff])

  const suggestions = useMemo(() => {
    if (studentId) return STUDENT_SUGGESTIONS
    if (paperId) {
      return isStaff
        ? PAPER_SUGGESTIONS
        : PAPER_SUGGESTIONS.filter((item) => !item.includes("区分度"))
    }
    return CLASS_SUGGESTIONS
  }, [studentId, paperId, isStaff])

  async function run(question = text) {
    const request = String(question ?? "").trim()
    if (!request) {
      setError("先写一句要问的问题")
      return
    }
    if (allowedIntents.length === 0) {
      setError("当前页面没有可查询的数据")
      return
    }
    const key = getDeepSeekKey()
    if (!key) {
      setError("请先在「AI 配置」里填写密钥")
      return
    }

    setBusy(true)
    setError("")
    setResult(null)
    try {
      const messages = buildAnalyticsIntentMessages({
        text: request,
        classInfo: classId ? { id: classId, name: className } : null,
        paperInfo: paperId ? { id: paperId, title: paperTitle } : null,
        studentInfo: studentId ? { id: studentId } : null,
        scope,
        intents: allowedIntents,
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
          maxTokens: 500,
          temperature: 0.1,
        })
        check = validateAnalyticsIntent(salvageJson(res.content), {
          allowedIntents,
          classId,
          paperId,
          studentId,
          scope,
        })
        if (check.ok) break
        lastReason = res.finishReason === "length" ? "输出被截断" : check.reason
      }
      if (!check?.ok) {
        setError(`模型连续 3 次没有按格式返回（${lastReason}）`)
        return
      }
      if (!check.intent) {
        setResult({ clarify: check.clarify })
        return
      }

      const intent = check.intent
      const supabase = createClient()

      if (intent.intent === "weak_nodes" || intent.intent === "practice_trend") {
        const { report, denied, error: loadError } = await loadClassReport(supabase, {
          classId: intent.params.class_id,
          days: intent.params.days,
        })
        if (denied) {
          setError("没有权限查看这个班级")
          return
        }
        if (loadError || !report) {
          setError(loadError?.message || "取不到班级数据")
          return
        }
        if (intent.intent === "weak_nodes") {
          const rows = buildWeakNodesRows(report, nodes)
          setResult({ ...intent, summary: buildWeakNodesSummary(report, rows), rows })
        } else {
          const rows = buildPracticeTrendRows(report)
          setResult({ ...intent, summary: buildPracticeSummary(report), rows })
        }
        return
      }

      if (intent.intent === "student_detail") {
        const { detail, denied, error: loadError } = await loadStudentDetail(
          supabase,
          intent.params.student_id
        )
        if (denied) {
          setError("没有权限查看这个学生")
          return
        }
        if (loadError || !detail) {
          setError(loadError?.message || "取不到学生数据")
          return
        }
        const rows = buildStudentDetailRows(detail, nodes)
        const wrong = buildStudentDetailWrongRows(detail)
        setResult({
          ...intent,
          summary: buildStudentDetailSummary(detail, rows, wrong),
          rows,
          wrong,
        })
        return
      }

      if (intent.intent === "question_stats") {
        const { stats, needClass, denied, error: loadError } = await loadPaperQuestionStats(
          supabase,
          {
            paperId: intent.params.paper_id,
            scope: intent.params.scope,
            classId: intent.params.class_id ?? activeClassId,
          }
        )
        if (needClass) {
          setResult({ clarify: "先在上方选择班级，再问这道题的正确率。" })
          return
        }
        if (denied) {
          setError("没有权限查看这份试卷的分析")
          return
        }
        if (loadError || !stats) {
          setError(loadError?.message || "取不到试题数据")
          return
        }
        const rows = buildQuestionStatsRows(stats)
        setResult({ ...intent, summary: buildQuestionStatsSummary(stats, rows), rows })
        return
      }

      if (intent.intent === "question_quality") {
        const { data, denied, error: loadError } = await loadPaperQuality(
          supabase,
          intent.params.paper_id
        )
        if (denied) {
          setError("只有教师/管理员可以看试题质量")
          return
        }
        if (loadError || !data) {
          setError(loadError?.message || "取不到试题质量数据")
          return
        }
        const rows = buildQuestionQualityRows(data)
        setResult({
          ...intent,
          summary: buildQuestionQualitySummary(data, rows),
          rows,
          note: data?.summary?.note ?? "",
        })
        return
      }

      if (intent.intent === "leaderboard") {
        const { board, needClass, denied, error: loadError } = await loadPaperLeaderboard(
          supabase,
          {
            paperId: intent.params.paper_id,
            scope: intent.params.scope,
            classId: intent.params.class_id ?? activeClassId,
          }
        )
        if (needClass) {
          setResult({ clarify: "先在上方选择班级，再看班级排行。" })
          return
        }
        if (denied) {
          setError("没有权限查看这份试卷的排行")
          return
        }
        if (loadError || !board) {
          setError(loadError?.message || "取不到排行数据")
          return
        }
        const rows = buildLeaderboardRows(board)
        setResult({ ...intent, summary: buildLeaderboardSummary(board, rows), rows })
      }
    } catch (err) {
      setError(err.message || "查询失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-base font-semibold">
            <SparklesIcon className="size-4" /> 问一句话看学情
          </span>
          <span className="text-xs text-muted-foreground">
            只走白名单查询，不写 SQL；结果只读，不改任何数据
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault()
                run()
              }
            }}
            placeholder={
              studentId
                ? "例如：这个学生最近练得怎么样？"
                : paperId
                  ? "例如：这次考试哪几道题正确率最低？"
                  : "例如：最近 30 天班里哪些知识点最弱？"
            }
            className="min-w-0 flex-1"
          />
          <Button type="button" onClick={() => run()} disabled={busy || !ready}>
            {busy ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <SparklesIcon className="size-4" />
            )}
            问
          </Button>
          {!hasKey && <AiConfigLink compact onChange={refresh} />}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((question) => (
            <Button
              key={question}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setText(question)
                run(question)
              }}
              disabled={busy}
            >
              {question}
            </Button>
          ))}
        </div>

        {error && <p className="text-xs text-rose-600">{error}</p>}
        <AskDataResult result={result} />
      </CardContent>
    </Card>
  )
}
