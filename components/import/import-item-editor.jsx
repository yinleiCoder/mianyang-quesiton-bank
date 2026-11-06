"use client"

// 单题编辑面板（预览页展开用）。刻意做轻：只改解析最常出错的那几处——
// 题干文字、选项、答案、解析、题型与难度，以及**复合题每个小问的题干**
//（小问拆分与串联是解析最常见的错，校对页不给改就只能入库后再找）。
// 小问的题型/选项/答案与排序留给「我的题目」里的完整编辑器（草稿本来就允许后续编辑），
// 这样既不重复实现一遍编辑器，也不用动那个 649 行的关键页面。
//
// 挂载方式：**条件挂载**（{editing === it.id && <ImportItemEditor …/>}）——
// React Compiler 会把常挂载组件里被记忆化闭包捕获的 state.prop 提到渲染期求值，
// item 为 null 时首渲染就崩。

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { blocksToPlain, textToBlocks, draftIssues } from "@/lib/import-pipeline"
import { answerTextOfAnswer } from "@/lib/import-answer-key"
import { QTYPES, DIFFICULTIES, qtypeLabel } from "@/lib/question-model"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2Icon, SaveIcon } from "lucide-react"

const isChoice = (qtype) => qtype === "single_choice" || qtype === "multiple_choice"

// 表单里答案的初值；切换「另一份答案」后重新灌入也用它——两处口径必须一致
const answerStateOf = (content) => ({
  keys: [...(content?.answer?.keys ?? [])],
  value: content?.answer?.value ?? true,
  values: [...(content?.answer?.values ?? [])],
  samples: (content?.answer?.samples ?? []).join("\n"),
})

// 这道题是不是"还差答案"（入库会被拒的那类）：用来高亮提示，别让人对着表单猜哪里没填
const stillNeedsAnswer = (qtype, content) =>
  draftIssues(qtype, content).some((s) => s.includes("答案") || s.includes("空位"))

export function ImportItemEditor({ item, resetToken = 0, onClose, onSaved }) {
  const [qtype, setQtype] = useState(item.qtype)
  const [difficulty, setDifficulty] = useState(item.difficulty)
  const [stem, setStem] = useState(() => blocksToPlain(item.content?.stem))
  const [options, setOptions] = useState(() =>
    (item.content?.options ?? []).map((o) => ({ key: o.key, text: blocksToPlain(o.label) }))
  )
  const [answer, setAnswer] = useState(() => answerStateOf(item.content))
  const [analysis, setAnalysis] = useState(() => blocksToPlain(item.content?.analysis))
  // 复合题各小问的题干（按 content.sub 的下标一一对应）。
  // 只存文本：题型/选项/答案原样带回去，不在这里改。
  const [subStems, setSubStems] = useState(() =>
    (item.content?.sub ?? []).map((sub) => blocksToPlain(sub?.stem))
  )
  const [busy, setBusy] = useState(false)

  // 上层切换了「另一份答案」：把答案输入重新灌成换过来的那份。
  // 只重灌答案，题干/解析里正在改的内容不动；普通轮询刷新不会触发（resetToken 只在切换后变）。
  useEffect(() => {
    setAnswer(answerStateOf(item.content))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken])

  function buildContent() {
    const content = { format_version: 1, stem: textToBlocks(stem) }
    if (isChoice(qtype)) {
      content.options = options.map((o) => ({ key: o.key, label: textToBlocks(o.text) }))
      content.answer = { type: "choice", keys: answer.keys }
    } else if (qtype === "true_false") {
      content.answer = { type: "tf", value: Boolean(answer.value) }
    } else if (qtype === "fill_blank") {
      content.answer = { type: "blank", values: answer.values }
    } else if (qtype === "short_answer") {
      content.answer = { type: "text", samples: answer.samples.split(/\n+/).map((s) => s.trim()).filter(Boolean) }
    } else if (qtype === "composite") {
      // 结构（几道小问、什么题型、答案）不动，只把改过的题干写回去
      content.sub = (item.content?.sub ?? []).map((sub, i) => ({
        ...sub,
        stem: textToBlocks(subStems[i] ?? blocksToPlain(sub?.stem)),
      }))
      content.answer = item.content?.answer
    }
    if (analysis.trim()) content.analysis = textToBlocks(analysis)
    return content
  }

  async function save(status) {
    if (busy) return
    const content = buildContent()
    const issues = draftIssues(qtype, content)
    if (status === "kept" && issues.length > 0) {
      toast.error(`还不能入库：${issues[0]}`)
      return
    }
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.rpc("import_update_item", {
        p_item_id: item.id,
        p_qtype: qtype,
        p_difficulty: difficulty,
        p_content: content,
        p_status: status ?? "kept",
      })
      if (error) throw new Error(error.message)
      toast.success("已保存")
      await onSaved()
      onClose()
    } catch (err) {
      toast.error(err?.message ?? "保存失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-muted/30 p-3">
      {/* 原卷没给答案的题：把这件事摆在最显眼处，并说清该做什么 */}
      {stillNeedsAnswer(qtype, item.content) && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          这道题还差答案（原卷可能就没印答案）：请在下面的答案区指定正确答案，保存后勾选它即可入库。
        </p>
      )}

      {/* 0146：答案区与题内/推导不一致时，这里提醒一句「保存会作废另一份」——
          想保留两份就对调，而不是重填 */}
      {item.answer_alt && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          这道题有<strong>两份答案</strong>：表单里是当前采用的一份，另一份存在任务里。
          <strong>在这里保存会作废另一份</strong>；想两边都留着对调，请回校对页用「改用这一份」。
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">题型</Label>
          <select
            value={qtype}
            onChange={(e) => setQtype(e.target.value)}
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
          >
            {QTYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">难度</Label>
          <div className="flex gap-1.5">
            {DIFFICULTIES.map((d) => (
              <Button
                key={d.value}
                size="sm"
                variant={difficulty === d.value ? "default" : "outline"}
                onClick={() => setDifficulty(d.value)}
              >
                {d.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">题干（换行分段；图用 [[图1]] 占位）</Label>
        <Textarea value={stem} onChange={(e) => setStem(e.target.value)} minRows={3} />
      </div>

      {isChoice(qtype) && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            选项（{qtype === "single_choice" ? "点选" : "勾选"}正确答案）
          </Label>
          {options.length < 2 && (
            <p className="text-xs text-rose-600">
              选项没解析出来：请先补上两个以上选项，再点选正确答案。
            </p>
          )}
          {options.map((o, i) => (
            <div key={o.key} className="flex items-center gap-2">
              <input
                type={qtype === "single_choice" ? "radio" : "checkbox"}
                className="size-4"
                checked={answer.keys.includes(o.key)}
                onChange={(e) => {
                  setAnswer((a) => ({
                    ...a,
                    keys: e.target.checked
                      ? qtype === "single_choice"
                        ? [o.key]
                        : [...a.keys, o.key]
                      : a.keys.filter((k) => k !== o.key),
                  }))
                }}
              />
              <span className="w-5 shrink-0 text-sm font-medium">{o.key}</span>
              <Input
                value={o.text}
                onChange={(e) =>
                  setOptions((list) => list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                }
              />
              {/* 删掉多余的选项：key 要重排，否则会与答案的字母对不上 */}
              <Button
                size="icon-sm"
                variant="ghost"
                title="删除这个选项"
                onClick={() => {
                  const next = options.filter((_, j) => j !== i)
                  const keyed = next.map((x, j) => ({ ...x, key: String.fromCharCode(65 + j) }))
                  setOptions(keyed)
                  setAnswer((a) => ({ ...a, keys: a.keys.filter((k) => keyed.some((x) => x.key === k)) }))
                }}
              >
                ×
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setOptions((list) => [...list, { key: String.fromCharCode(65 + list.length), text: "" }])
              }
            >
              增加选项
            </Button>
            {options.length === 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOptions(["A", "B", "C", "D"].map((k) => ({ key: k, text: "" })))}
              >
                补 A/B/C/D 四个空选项
              </Button>
            )}
          </div>
        </div>
      )}

      {qtype === "true_false" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">正确答案</Label>
          <div className="flex gap-1.5">
            <Button size="sm" variant={answer.value ? "default" : "outline"} onClick={() => setAnswer((a) => ({ ...a, value: true }))}>
              对
            </Button>
            <Button size="sm" variant={!answer.value ? "default" : "outline"} onClick={() => setAnswer((a) => ({ ...a, value: false }))}>
              错
            </Button>
          </div>
        </div>
      )}

      {qtype === "fill_blank" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            各空答案（顺序与题干里的 ______ 一致，共 {answer.values.length} 个）
          </Label>
          {answer.values.map((v, i) => (
            <Input
              key={i}
              value={v}
              placeholder={`第 ${i + 1} 空`}
              onChange={(e) => setAnswer((a) => ({ ...a, values: a.values.map((x, j) => (j === i ? e.target.value : x)) }))}
            />
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAnswer((a) => ({ ...a, values: [...a.values, ""] }))}
          >
            增加一个空
          </Button>
        </div>
      )}

      {qtype === "short_answer" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">参考答案（一行一条）</Label>
          <Textarea
            value={answer.samples}
            onChange={(e) => setAnswer((a) => ({ ...a, samples: e.target.value }))}
            minRows={3}
          />
        </div>
      )}

      {qtype === "composite" && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">
            子题（共 {subStems.length} 道，可改题干；题型、选项与答案请入库后在完整编辑器里调整）
          </Label>
          {subStems.length === 0 && (
            <p className="text-xs text-rose-600">
              这道综合题没有解析出子题，入库会被拒绝：可回解析页重跑，或改用完整编辑器补。
            </p>
          )}
          {subStems.map((text, i) => {
            const sub = item.content?.sub?.[i] ?? {}
            const answer = answerTextOfAnswer(sub.answer)
            return (
              <div key={i} className="space-y-1 rounded-lg border bg-background p-2">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">第 {i + 1} 小问</span>
                  <span>· {qtypeLabel(sub.type)}</span>
                  {answer && <span className="ml-auto">答案：{answer}</span>}
                </div>
                <Textarea
                  value={text}
                  onChange={(e) =>
                    setSubStems((list) => list.map((x, j) => (j === i ? e.target.value : x)))
                  }
                  minRows={2}
                />
              </div>
            )
          })}
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">解析</Label>
        <Textarea value={analysis} onChange={(e) => setAnalysis(e.target.value)} minRows={2} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => save("kept")} disabled={busy}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
          保存并保留
        </Button>
        <Button variant="outline" onClick={() => save("skipped")} disabled={busy}>
          保存并跳过
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          取消
        </Button>
      </div>
    </div>
  )
}
