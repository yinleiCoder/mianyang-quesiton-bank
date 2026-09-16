"use client"

// 题目编辑器：六种题型 + 复合题（材料+子题）。内部编辑态经 lib/question-model 序列化/校验后走 RPC 落库。
// 草稿保存需内容结构完整（DB 校验收口）；提交额外要求标签与解析，校验错误逐条 toast。
import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import {
  QTYPES,
  DIFFICULTIES,
  qtypeLabel,
  difficultyLabel,
  isChoiceType,
  countBlanks,
  blocksToText,
  optionLetter,
  makeOption,
  defaultDraft,
  defaultSub,
  blankPanel,
  serializeContent,
  validateContent,
} from "@/lib/question-model"
import { indexNodes } from "@/lib/subject-nodes"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { BlockEditor } from "@/components/questions/block-editor"
import { TagPicker } from "@/components/questions/tag-picker"
import { NodeField } from "@/components/questions/node-field"
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  SaveIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

// 空位答案随题干空位数量自动对齐（保留已填内容）
function resizeBlanks(blanks, need) {
  const next = [...(blanks ?? [])]
  while (next.length < need) next.push("")
  if (next.length > need) next.length = need
  return next
}

/* ============ 题型内面板（对 part 对象操作；根题与子题复用） ============ */
function TypePanel({ qtype, part, onChange }) {
  const change = (patch) => onChange({ ...part, ...patch })
  const stemText = blocksToText(part.stem)
  const need = countBlanks(stemText)

  if (isChoiceType(qtype)) {
    const single = qtype === "single_choice"
    const selected = single ? part.selection : null
    return (
      <div className="space-y-2">
        {part.options.map((o, i) => {
          const on = single ? selected === o.id : part.multiSelection.includes(o.id)
          return (
            <div key={o.id} className="flex items-start gap-2 rounded-lg border bg-muted/30 p-2">
              <button
                type="button"
                aria-label={on ? "取消选择" : single ? "设为正确答案" : "切换选择"}
                onClick={() => {
                  if (single) {
                    change({ selection: on ? null : o.id })
                  } else {
                    const set = new Set(part.multiSelection)
                    if (set.has(o.id)) set.delete(o.id)
                    else set.add(o.id)
                    change({ multiSelection: [...set] })
                  }
                }}
                className={`mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  on ? "border-primary bg-primary text-primary-foreground" : "hover:border-foreground/50"
                }`}
              >
                {on && <CheckIcon className="size-3" />}
              </button>
              <span className="mt-1.5 w-5 shrink-0 text-center font-mono text-sm font-semibold text-muted-foreground">
                {optionLetter(i)}
              </span>
              <div className="min-w-0 flex-1">
                <BlockEditor
                  blocks={o.label}
                  onChange={(label) =>
                    change({ options: part.options.map((x, xi) => (xi === i ? { ...x, label } : x)) })
                  }
                  placeholder={`选项内容${on ? "（当前标记为答案）" : ""}`}
                  minRows={1}
                  compact
                  noMedia // 选项纯文字：不提供插图/音视频/文件入口（题干/解析处可插媒体）
                />
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <UpDown
                  disabledUp={i === 0}
                  disabledDown={i === part.options.length - 1}
                  onUp={() => swap(part.options, i, i - 1, (options) => change({ options }))}
                  onDown={() => swap(part.options, i, i + 1, (options) => change({ options }))}
                />
                <button
                  type="button"
                  aria-label="删除选项"
                  disabled={part.options.length <= 2}
                  onClick={() => {
                    const options = part.options.filter((_, xi) => xi !== i)
                    const multi = part.multiSelection.filter((id) => options.some((x) => x.id === id))
                    change({ options, multiSelection: multi, selection: selected === o.id ? null : selected })
                  }}
                  className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
            </div>
          )
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => change({ options: [...part.options, makeOption()] })}
        >
          <PlusIcon className="size-3.5" /> 添加选项
        </Button>
        <p className="text-xs text-muted-foreground">
          先点题干旁{" "}
          <span className="font-medium text-foreground">{single ? "圆点" : "方框"}</span>{" "}
          选择答案，再编辑选项内容；拖拽不可用时可点 {single ? "圆点" : "方框"} 切换，选项用上下箭头排序。
        </p>
      </div>
    )
  }

  if (qtype === "true_false") {
    return (
      <div className="flex flex-wrap gap-2">
        {[
          { v: true, label: "正确（√）" },
          { v: false, label: "错误（×）" },
        ].map((o) => (
          <button
            key={String(o.v)}
            type="button"
            onClick={() => change({ tfValue: o.v })}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
              part.tfValue === o.v
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:border-foreground/40"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    )
  }

  if (qtype === "fill_blank") {
    return (
      <div className="space-y-2">
        <div
          className={`flex items-center gap-2 text-xs ${
            part.blanks.length === need ? "text-muted-foreground" : "text-amber-600"
          }`}
        >
          <AlertTriangleIcon className="size-3.5" />
          题干中有 {need} 个空位（连续 3 个下划线），答案 {part.blanks.length} 个
          {part.blanks.length !== need ? "——请调整题干或点下方按钮同步" : ""}
        </div>
        {part.blanks.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-sm text-muted-foreground">
              空位 {i + 1} 答案
            </span>
            <Input
              value={v}
              onChange={(e) =>
                change({ blanks: part.blanks.map((x, xi) => (xi === i ? e.target.value : x)) })
              }
              placeholder={`第 ${i + 1} 个空的答案`}
              className="max-w-sm"
            />
          </div>
        ))}
        {part.blanks.length !== need && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => change({ blanks: resizeBlanks(part.blanks, need) })}
          >
            同步为 {need} 个答案框
          </Button>
        )}
      </div>
    )
  }

  if (qtype === "short_answer") {
    return (
      <Textarea
        value={part.samples}
        onChange={(e) => change({ samples: e.target.value })}
        placeholder={"参考答案（可多行，每行视为一份参考答案/要点）\n例如：\n1. 安全用电的六条要求…\n2. …"}
        className="min-h-28"
      />
    )
  }
  return null
}

function swap(arr, a, b, commit) {
  if (a < 0 || b < 0 || a >= arr.length || b >= arr.length) return
  const next = [...arr]
  ;[next[a], next[b]] = [next[b], next[a]]
  commit(next)
}

function UpDown({ onUp, onDown, disabledUp, disabledDown }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        aria-label="上移"
        disabled={disabledUp}
        onClick={onUp}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ArrowUpIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="下移"
        disabled={disabledDown}
        onClick={onDown}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ArrowDownIcon className="size-3.5" />
      </button>
    </span>
  )
}

/* ============ 复合题子题卡片 ============ */
function SubCard({ index, sub, onPatch, onRemove, onMoveUp, onMoveDown, isFirst, isLast, count }) {
  return (
    <Card className="border-dashed">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">子题 {index + 1}</Badge>
          <select
            aria-label="子题题型"
            value={sub.type}
            onChange={(e) =>
              // 换题型重置作答面板，题干保留
              onPatch({ ...blankPanel({ stem: sub.stem }), type: e.target.value })
            }
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            {QTYPES.filter((t) => t.value !== "composite").map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">第 {index + 1} 小题</span>
          <span className="ml-auto inline-flex items-center gap-0.5">
            <UpDown
              onUp={onMoveUp}
              onDown={onMoveDown}
              disabledUp={isFirst}
              disabledDown={isLast}
            />
            <button
              type="button"
              aria-label="删除子题"
              disabled={count <= 1}
              onClick={onRemove}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </span>
        </div>
        <Label className="text-xs text-muted-foreground">子题题干</Label>
        <BlockEditor
          blocks={sub.stem}
          onChange={(stem) =>
            onPatch({ stem, blanks: resizeBlanks(sub.blanks, countBlanks(blocksToText(stem))) })
          }
          placeholder={`第 ${index + 1} 小题题干…（含空位时用连续 3 个下划线，如 ____）`}
          minRows={2}
        />
        <TypePanel qtype={sub.type} part={sub} onChange={onPatch} />
      </CardContent>
    </Card>
  )
}

/* ============ 主编辑器 ============ */
export function QuestionEditor({
  nodes,
  initial, // 编辑模式：fromContent 产物；新建传 null
  versionId = null, // 已落库的版本行（编辑/退回重提）
  returnedNote = null, // { comment, decidedByName, decidedAt }
  mode = "new",
  reviseQuestionId = null, // 改版模式：已入库题 id；保存走 create_edit_draft（新版本草稿），节点沿用原题
}) {
  const router = useRouter()
  const [d, setD] = useState(() => initial ?? defaultDraft())
  const [vid, setVid] = useState(versionId)
  const [busy, setBusy] = useState("") // '' | 'save' | 'submit'
  const [warn, setWarn] = useState([])
  const revising = Boolean(reviseQuestionId)

  const set = (patch) => setD((prev) => ({ ...prev, ...patch }))
  const patchSub = (id, patch) =>
    setD((prev) => ({
      ...prev,
      subs: prev.subs.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }))

  // 改版模式：节点由原题锁定，仅展示科目路径
  const lockedNodePath = useMemo(() => {
    if (!reviseQuestionId) return ""
    return indexNodes(nodes ?? []).pathOf(d.nodeId)
  }, [reviseQuestionId, nodes, d.nodeId])

  function switchQtype(t) {
    setD((prev) => {
      if (prev.qtype === t) return prev
      if (t === "composite") {
        return { ...prev, qtype: t, subs: [defaultSub("single_choice")] }
      }
      // 选择题型在单选/多选间互切时保留选项与选择（按 id，答案不错位）
      if (isChoiceType(t) && isChoiceType(prev.qtype)) {
        return { ...prev, qtype: t }
      }
      return { ...prev, ...blankPanel({ stem: prev.stem }), qtype: t }
    })
  }

  async function persist(thenSubmit) {
    const content = serializeContent(d)
    if (!revising && !d.nodeId) {
      toast.warning("请先选择所属科目节点")
      return
    }
    if (d.qtype === "composite" && d.subs.length === 0) {
      toast.warning("复合题请至少添加 1 个子题")
      return
    }
    // 草稿也要结构完整（DB 校验收口）；标签/解析在提交时强校验
    const errors = validateContent(d, { requireTags: thenSubmit })
    if (errors.length > 0) {
      setWarn(errors)
      toast.error("请先修正以下问题", { description: errors.slice(0, 4).join("；") })
      return
    }
    setWarn([])
    setBusy(thenSubmit ? "submit" : "save")
    const supabase = createClient()
    // 两个落库函数的参数集不同：create_question_draft 需要 p_course_node（新建时定节点），
    // update_question_draft 没有该参数——改节点不在其职责内，多传会被 PostgREST 判为「函数不存在」。
    const draftArgs = {
      p_qtype: d.qtype,
      p_difficulty: d.difficulty,
      p_content: content,
      p_tag_ids: d.tags.map((t) => t.id),
    }
    try {
      let currentVid = vid
      if (!currentVid) {
        // 改版：不新建题目，在题目下开新版本草稿走两级重审（节点沿用原题，DB 收口）
        const { data, error } = revising
          ? await supabase.rpc("create_edit_draft", {
              p_question_id: reviseQuestionId,
              p_qtype: d.qtype,
              p_difficulty: d.difficulty,
              p_content: content,
              p_tag_ids: d.tags.map((t) => t.id),
            })
          : await supabase.rpc("create_question_draft", { p_course_node: d.nodeId, ...draftArgs })
        if (error) throw error
        currentVid = data
        setVid(currentVid)
      } else {
        const { error } = await supabase.rpc("update_question_draft", {
          p_version_id: currentVid,
          ...draftArgs,
        })
        if (error) throw error
      }
      if (thenSubmit) {
        const { error } = await supabase.rpc("submit_question", { p_version_id: currentVid })
        if (error) throw error
        // 作者兼任组长时 DB 会跳过组长环节直达专家；按实际落库状态提示与跳转
        const { data: afterV } = await supabase
          .from("question_versions")
          .select("status")
          .eq("id", currentVid)
          .maybeSingle()
        const atCity = afterV?.status === "pending_city"
        toast.success(
          revising
            ? atCity
              ? "改版已提交审核（你兼任该课程教研组长，已直达市级专家审核）"
              : "改版已提交审核，等待教研组长审核"
            : atCity
              ? "已提交审核（你兼任该课程教研组长，已直达市级专家审核）"
              : "已提交，等待教研组长审核"
        )
        router.push(`/questions?tab=mine&status=${atCity ? "pending_city" : "pending_group"}`)
      } else {
        toast.success(
          currentVid === vid && vid
            ? "草稿已保存"
            : revising
              ? "改版草稿已保存（旧版本在审批期间照常在线使用）"
              : "草稿已保存（可继续编辑后提交）"
        )
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy("")
    }
  }

  const typeBtns = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {QTYPES.map((t) => {
        const active = d.qtype === t.value
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => switchQtype(t.value)}
            className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
              active
                ? "border-primary bg-primary/5 font-medium text-primary"
                : "hover:border-foreground/30"
            }`}
          >
            {t.label}
            {t.value === "composite" && (
              <span className="block text-xs text-muted-foreground">材料 + 多道小题</span>
            )}
          </button>
        )
      })}
    </div>
  )

  const diffBtns = (
    <div className="flex gap-1.5">
      {DIFFICULTIES.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => set({ difficulty: value })}
          className={`rounded-md px-3 py-1 text-sm transition-colors ${
            d.difficulty === value
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/60"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="space-y-4">
      {returnedNote && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <p className="font-medium">
            该题被{returnedNote.decidedByName ?? "审批人"}退回（{returnedNote.decidedAt}），请按意见修改后重新提交，将从组长环节重新审核：
          </p>
          <p className="mt-1 whitespace-pre-wrap">{returnedNote.comment ?? "（未填写退回意见）"}</p>
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="space-y-1.5">
            <Label>题型</Label>
            {typeBtns}
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <Label className="text-sm font-normal text-muted-foreground">难度</Label>
              {diffBtns}
            </div>
            {vid && (
              <Badge variant="outline">
                {mode === "edit"
                  ? "修改被退回版本"
                  : revising
                    ? "改版草稿已落库（旧版仍在线）"
                    : "草稿已落库"}
              </Badge>
            )}
            {warn.length > 0 && <Badge className="bg-rose-100 text-rose-700">{warn.length} 处待修正</Badge>}
            <p className="text-xs text-muted-foreground">
              {d.qtype === "composite"
                ? "先写阅读材料/情境，再逐题添加子题。"
                : "题干可分段；填空请在题干中用连续 3 个以上下划线表示空位。"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="space-y-1.5">
            <Label>归属科目</Label>
            {revising ? (
              <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                {lockedNodePath}
                <span className="ml-2 text-xs text-muted-foreground">改版沿用原科目节点，不可更改</span>
              </p>
            ) : (
              <NodeField nodes={nodes} value={d.nodeId} onChange={(nodeId) => set({ nodeId })} />
            )}
          </div>
          <div className="space-y-1.5">
            <Label>{d.qtype === "composite" ? "材料（情境/阅读材料）" : "题干"}</Label>
            <BlockEditor
              blocks={d.stem}
              onChange={(stem) => {
                if (d.qtype === "fill_blank") {
                  set({ stem, blanks: resizeBlanks(d.blanks, countBlanks(blocksToText(stem))) })
                } else {
                  set({ stem })
                }
              }}
              placeholder={d.qtype === "composite" ? "粘贴或编写材料、情境、图表说明…" : "输入题干…（可 Ctrl+Enter 分段）"}
              minRows={d.qtype === "composite" ? 4 : 2}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <Label>{d.qtype === "composite" ? "子题" : "作答部分"}</Label>
          {d.qtype === "composite" ? (
            <div className="space-y-3">
              {d.subs.map((sub, i) => (
                <SubCard
                  key={sub.id}
                  index={i}
                  count={d.subs.length}
                  sub={sub}
                  isFirst={i === 0}
                  isLast={i === d.subs.length - 1}
                  onPatch={(patch) => patchSub(sub.id, patch)}
                  onRemove={() => set({ subs: d.subs.filter((s) => s.id !== sub.id) })}
                  onMoveUp={() => swap(d.subs, i, i - 1, (subs) => set({ subs }))}
                  onMoveDown={() => swap(d.subs, i, i + 1, (subs) => set({ subs }))}
                />
              ))}
              <div className="flex flex-wrap gap-2">
                {QTYPES.filter((t) => t.value !== "composite").map((t) => (
                  <Button
                    key={t.value}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={d.subs.length >= 20}
                    onClick={() =>
                      set({ subs: [...d.subs, { ...defaultSub(t.value), id: d.nextSubId }], nextSubId: d.nextSubId + 1 })
                    }
                  >
                    <PlusIcon className="size-3.5" /> {t.label.replace(/（.*/, "")}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <TypePanel qtype={d.qtype} part={d} onChange={(patch) => setD((prev) => ({ ...prev, ...patch }))} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="space-y-1.5">
            <Label>
              解析<span className="font-normal text-muted-foreground">（提交时必填）</span>
            </Label>
            <BlockEditor
              blocks={d.analysis}
              onChange={(analysis) => set({ analysis })}
              placeholder="说明解题思路、易错点、参考答案依据…"
              minRows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label>知识点标签</Label>
            <TagPicker value={d.tags} onChange={(tags) => set({ tags })} />
          </div>
          {warn.length > 0 && (
            <div className="space-y-1 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              {warn.slice(0, 6).map((w, i) => (
                <p key={i} className="flex items-start gap-1.5">
                  <XIcon className="mt-0.5 size-3.5 shrink-0" /> {w}
                </p>
              ))}
              {warn.length > 6 && <p className="text-xs">…共 {warn.length} 项</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-2 rounded-xl border bg-background/95 p-2 shadow-sm backdrop-blur">
        <p className="mr-auto px-2 text-xs text-muted-foreground">
          {qtypeLabel(d.qtype)} · {difficultyLabel(d.difficulty)}难度
          {d.nodeId ? " · 已选题" : ""}
        </p>
        <Button variant="outline" onClick={() => router.push("/questions")} disabled={Boolean(busy)}>
          取消
        </Button>
        <Button variant="secondary" onClick={() => persist(false)} disabled={Boolean(busy) || !d.nodeId}>
          {busy === "save" ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
          保存草稿
        </Button>
        <Button onClick={() => persist(true)} disabled={Boolean(busy) || !d.nodeId}>
          {busy === "submit" ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
          提交审核
        </Button>
      </div>
    </div>
  )
}
