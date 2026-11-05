"use client"

// 一句话组卷入口：教师说一句要求 → LLM 只解析成约束 → 教师确认后套用到下面的表单。
//
// **不在本组件里选题**：套用只改 planner 的 rows/target/exclude/tags，
// 生成方案仍走 optimizePaperPlan。密钥只从本机 localStorage 取，站点不出钱。
import { useEffect, useMemo, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { getDeepSeekKey, getDeepSeekModel } from "@/lib/deepseek-prefs"
import { callChat, salvageJson } from "@/lib/deepseek"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import {
  buildPaperIntentMessages,
  intentToRows,
  validatePaperIntent,
} from "@/lib/paper-intent-prompt"
import { TAG_FULL_COLUMNS, tagsInScope } from "@/lib/tag-tree"
import { QTYPES, qtypeShortLabel } from "@/lib/question-model"
import { AiConfigLink } from "@/components/settings/ai-config-link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Loader2Icon, SparklesIcon } from "lucide-react"

export function PaperIntentPanel({
  courseNodeId = null,
  courseNodeName = null,
  nodes = [],
  currentTarget = null,
  currentSections = [],
  tags: tagsProp = null,
  initialParsed = null,
  onApplyIntent,
}) {
  const { ready, hasKey, model, refresh } = useDeepSeekPrefs()
  const [text, setText] = useState("")
  const [tags, setTags] = useState(tagsProp ?? [])
  const [tagError, setTagError] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [parsed, setParsed] = useState(initialParsed)

  // 夹具页传 tags 时不再连库；正式页面在弹窗打开时取一次标签字典。
  useEffect(() => {
    if (tagsProp) {
      setTags(tagsProp)
      return
    }
    let alive = true
    const supabase = createClient()
    supabase
      .from("tags")
      .select(TAG_FULL_COLUMNS)
      .order("name")
      .then(({ data, error: loadError }) => {
        if (!alive) return
        if (loadError) {
          setTagError("标签加载失败：仍可解析题数/分值，但无法按知识点配题")
          return
        }
        setTags(data ?? [])
      })
    return () => {
      alive = false
    }
  }, [tagsProp])

  // 没选科目节点时不把全库标签塞给模型：候选池为空，提示先选科目。
  const tagPool = useMemo(
    () => (courseNodeId ? tagsInScope(tags, courseNodeId, nodes) : []),
    [tags, courseNodeId, nodes]
  )

  async function run() {
    const request = text.trim()
    if (!request) {
      setError("先写一句组卷要求")
      return
    }
    const key = getDeepSeekKey()
    if (!key) {
      setError("请先在「AI 配置」里填写密钥")
      return
    }

    setBusy(true)
    setError("")
    setParsed(null)
    try {
      const node = courseNodeId
        ? { id: courseNodeId, name: courseNodeName || "当前科目" }
        : null
      const messages = buildPaperIntentMessages({
        text: request,
        node,
        nodes,
        tags: tagPool,
        qtypes: QTYPES,
        currentTarget,
        currentSections,
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
          // 8 个大题的 JSON 可能超过 1500 token（实测截断过），给足 3000
          maxTokens: 3000,
          temperature: 0.2,
        })
        check = validatePaperIntent(salvageJson(res.content), {
          allowedNodeIds: courseNodeId ? [courseNodeId] : [],
          allowedTags: tagPool,
          allowedQtypes: QTYPES.map((qtype) => qtype.value),
        })
        if (check.ok) break
        lastReason = res.finishReason === "length" ? "输出被截断" : check.reason
      }
      if (!check?.ok) {
        setError(`模型连续 3 次没有按格式返回（${lastReason}）`)
        return
      }
      const matchedTags = check.intent.requested_tag_ids
        .map((id) => tagPool.find((tag) => tag.id === id))
        .filter(Boolean)
      setParsed({ ...check, matchedTags })
    } catch (err) {
      setError(err.message || "解析失败")
    } finally {
      setBusy(false)
    }
  }

  function apply() {
    if (!parsed?.intent?.sections?.length) {
      setError("还需要补充信息，暂不能套用")
      return
    }
    onApplyIntent?.(parsed.intent, { tags: parsed.matchedTags ?? [] })
  }

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <SparklesIcon className="size-4" /> 一句话组卷
        </span>
        <span className="text-xs text-muted-foreground">
          AI 只把原话解析成约束，选题仍由本地优化器完成
        </span>
      </div>

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="例如：出一份 90 分的高一数学期中卷，基础 60%、中档 30%、难 10%，第三章为主，近一个月用过的题不要。"
        minRows={2}
        className="mt-2 resize-none bg-background"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={run} disabled={busy || !ready}>
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <SparklesIcon className="size-3.5" />
          )}
          解析这句话
        </Button>
        {!hasKey && <AiConfigLink compact onChange={refresh} />}
        <span className="text-xs text-muted-foreground">
          密钥只存本机；解析结果先给你确认，不会自动改卷
        </span>
      </div>

      {!courseNodeId && (
        <p className="mt-2 text-xs text-amber-700">
          卷面还没选科目节点：仍可解析题数/分值，但无法按知识点配题。
        </p>
      )}
      {tagError && <p className="mt-2 text-xs text-amber-700">{tagError}</p>}
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

      {parsed && (
        <IntentPreview
          parsed={parsed}
          busy={busy}
          onApply={apply}
          onRetry={run}
        />
      )}
    </div>
  )
}

function IntentPreview({ parsed, busy, onApply, onRetry }) {
  const intent = parsed.intent
  const rows = intentToRows(intent)

  if (intent.clarify) {
    return (
      <div className="mt-3 rounded-md border border-amber-300 bg-amber-50/70 p-3 text-sm text-amber-900">
        <p className="font-medium">还需要你补充</p>
        <p className="mt-1">{intent.clarify}</p>
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onRetry} disabled={busy}>
          重新解析
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">我理解成了</span>
        <Button type="button" size="sm" onClick={onApply} disabled={busy}>
          套用到下面的表单
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="secondary" className="font-normal">
          目标分 {intent.target_score ?? "不限"}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          排除近 {intent.exclude_recent_days} 天
        </Badge>
        <Badge variant="secondary" className="font-normal">
          科目：{intent.node_id ? "当前卷面" : "未指定"}
        </Badge>
        {parsed.matchedTags?.length > 0 ? (
          parsed.matchedTags.map((tag) => (
            <Badge key={tag.id} variant="outline" className="font-normal">
              {tag.name}
            </Badge>
          ))
        ) : (
          <span className="text-muted-foreground">没有指定优先标签</span>
        )}
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b text-left">
              <th className="py-1 pr-2 font-normal">大题</th>
              <th className="py-1 pr-2 font-normal">题型</th>
              <th className="py-1 pr-2 font-normal">题数</th>
              <th className="py-1 pr-2 font-normal">分值</th>
              <th className="py-1 font-normal">难度 易/中/难</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b last:border-0">
                <td className="py-1 pr-2">{row.title}</td>
                <td className="py-1 pr-2">{qtypeShortLabel(row.qtype)}</td>
                <td className="py-1 pr-2">{row.count}</td>
                <td className="py-1 pr-2">
                  {row.score_each} 分 / {row.score_mode === "per_blank" ? "空" : row.score_mode === "per_sub" ? "小问" : "题"}
                </td>
                <td className="py-1">
                  {row.mix[1]} / {row.mix[2]} / {row.mix[3]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {intent.assumptions?.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {intent.assumptions.map((item, index) => (
            <li key={index}>· 假设：{item}</li>
          ))}
        </ul>
      )}

      {parsed.warnings?.length > 0 && (
        <ul className="mt-2 rounded-md border border-amber-300 bg-amber-50/70 p-2 text-xs text-amber-900">
          {parsed.warnings.map((warning, index) => (
            <li key={index}>· {warning}</li>
          ))}
        </ul>
      )}

      <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={onRetry} disabled={busy}>
        重新解析
      </Button>
    </div>
  )
}
