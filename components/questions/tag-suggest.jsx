"use client"

// 题目编辑器里的 AI 知识点推荐：只给建议，教师点「采纳」才进 TagPicker。
//
// 候选池与 TagPicker 同口径（当前科目子树，见 0096）；不写 version_tags、不自动保存。
// 密钥仍从本机 localStorage 取，站点不出钱。
import { useEffect, useMemo, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { getDeepSeekKey, getDeepSeekModel } from "@/lib/deepseek-prefs"
import { callChat, salvageJson } from "@/lib/deepseek"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import {
  buildTagSuggestMessages,
  validateTagSuggestion,
} from "@/lib/tag-suggest-prompt"
import { TAG_FULL_COLUMNS, tagsInScope } from "@/lib/tag-tree"
import { blocksToText, serializeContent } from "@/lib/question-model"
import { AiConfigLink } from "@/components/settings/ai-config-link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2Icon, SparklesIcon } from "lucide-react"

export function TagSuggest({
  draft,
  subjectNodeId = null,
  nodes = [],
  value = [],
  onAdd,
}) {
  const { ready, hasKey, model, refresh } = useDeepSeekPrefs()
  const [tags, setTags] = useState([])
  const [loadError, setLoadError] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [suggestions, setSuggestions] = useState(null)

  useEffect(() => {
    let alive = true
    const supabase = createClient()
    supabase
      .from("tags")
      .select(TAG_FULL_COLUMNS)
      .order("name")
      .then(({ data, error: loadErr }) => {
        if (!alive) return
        if (loadErr) {
          setLoadError("标签加载失败，暂时不能推荐")
          return
        }
        setTags(data ?? [])
      })
    return () => {
      alive = false
    }
  }, [])

  const tagPool = useMemo(
    () => (subjectNodeId ? tagsInScope(tags, subjectNodeId, nodes) : []),
    [tags, subjectNodeId, nodes]
  )
  // 换科目后上一轮推荐全部作废：它们是按旧学科的候选池算出来的，留着还能点「采纳」，
  // 就会把别的学科的标签打进这道题（入库只校验标签存在，不校验学科——见 check_tags_exist）。
  useEffect(() => {
    setSuggestions(null)
    setError("")
  }, [subjectNodeId])

  const stemText = blocksToText(draft?.stem ?? [])
  const canRun = Boolean(subjectNodeId) && stemText.trim().length >= 10 && tagPool.length > 0
  const hint = !subjectNodeId
    ? "先选科目，AI 才知道从哪个学科的知识点里选"
    : stemText.trim().length < 10
      ? "题干太短，先写清楚题目再推荐"
      : tagPool.length === 0
        ? "该科目下还没有知识点标签，先去管理台建树"
        : "只给建议，采纳后才进表单"

  async function run() {
    setError("")
    setSuggestions(null)
    if (!subjectNodeId) {
      setError(hint)
      return
    }
    if (stemText.trim().length < 10) {
      setError(hint)
      return
    }
    if (tagPool.length === 0) {
      setError(hint)
      return
    }
    const key = getDeepSeekKey()
    if (!key) {
      setError("请先在「AI 配置」里填写密钥")
      return
    }

    setBusy(true)
    try {
      const selectedTagIds = value.map((tag) => tag.id)
      const messages = buildTagSuggestMessages({
        qtype: draft?.qtype,
        content: serializeContent(draft ?? {}),
        tags: tagPool,
        selectedTagIds,
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
          maxTokens: 800,
          temperature: 0.2,
        })
        check = validateTagSuggestion(salvageJson(res.content), {
          allowedTags: tagPool,
          selectedTagIds,
        })
        if (check.ok) break
        lastReason = res.finishReason === "length" ? "输出被截断" : check.reason
      }
      if (!check?.ok) {
        setError(`模型连续 3 次没有按格式返回（${lastReason}）`)
        return
      }
      const items = check.suggestion.tags
        .map((item) => {
          const tag = tagPool.find((candidate) => candidate.id === item.tag_id)
          return tag ? { ...item, tag } : null
        })
        .filter(Boolean)
      setSuggestions({
        tags: items,
        caveats: check.suggestion.caveats,
        warnings: check.warnings,
      })
    } catch (err) {
      setError(err.message || "推荐失败")
    } finally {
      setBusy(false)
    }
  }

  function adopt(items) {
    // 双保险：只采纳仍在**当前**候选池里的（上面的 effect 已经会清掉旧建议，
    // 但采纳与换科目可能发生在同一帧里，这里再按当下的池子筛一次）
    const allowed = new Set(tagPool.map((tag) => tag.id))
    const picked = items
      .map((item) => item.tag)
      .filter((tag) => tag && allowed.has(tag.id))
    if (picked.length === 0) {
      setSuggestions(null)
      setError("科目已更换，这些建议不再适用，请重新推荐")
      return
    }
    onAdd?.(picked)
    // 已采纳的从建议里移除，方便逐条点；全部采纳后列表为空。
    setSuggestions((prev) =>
      prev
        ? {
            ...prev,
            tags: prev.tags.filter(
              (item) => !picked.some((tag) => tag.id === item.tag.id)
            ),
          }
        : prev
    )
  }

  return (
    <div className="rounded-lg border bg-muted/20 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={run}
          disabled={busy || !ready || !canRun}
        >
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <SparklesIcon className="size-3.5" />
          )}
          AI 推荐标签
        </Button>
        {!hasKey && <AiConfigLink compact onChange={refresh} />}
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>

      {loadError && <p className="mt-2 text-xs text-amber-700">{loadError}</p>}
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

      {suggestions && (
        <div className="mt-2 space-y-1">
          {suggestions.tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              没有匹配的标签，可手动搜索或新建。
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {suggestions.tags.map((item) => (
                <Badge
                  key={item.tag.id}
                  variant="secondary"
                  className="gap-1 font-normal"
                  title={item.reason}
                >
                  {item.tag.name}
                  <span className="text-[10px] text-muted-foreground">
                    {Math.round(item.confidence * 100)}%
                  </span>
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => adopt([item])}
                  >
                    采纳
                  </button>
                </Badge>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => adopt(suggestions.tags)}
              >
                全部采纳
              </Button>
            </div>
          )}
          {suggestions.caveats && (
            <p className="text-xs text-muted-foreground">{suggestions.caveats}</p>
          )}
          {suggestions.warnings?.length > 0 && (
            <ul className="text-xs text-amber-700">
              {suggestions.warnings.map((warning, index) => (
                <li key={index}>· {warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
