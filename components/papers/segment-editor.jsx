"use client"

// 被指派人的片段编辑器（0085）：只编辑分给自己的那几段之一。
//
// 布局与组卷编辑器同源（左选题器 / 右我的槽位），但**只动自己那一段**：
//   · 我的槽位按「大题内部第 X~Y 题」摆 —— **题号是绝对的**。直接渲染"我的题"
//     会让第 3~7 题显示成第 1~5 题，这是设计时记下的坑（buildSegmentView 负责摆位）。
//   · 别人的题只作为上下文显示（只读、灰色），不参与提交。
//   · 保存走 save_paper_assignment（段级乐观锁：token 是这一段的 updated_us），
//     不是整卷保存 —— 服务端只替换「assignment_id = 这一段」的行。
//   · 「提交这段」= submitted，交了即锁；再改要找创始人解锁。
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { assignmentStateChip, segmentProgress } from "@/lib/paper-assignments"
import { QuestionPicker } from "@/components/papers/question-picker"
import { QuestionView } from "@/components/questions/question-view"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { ArrowDownIcon, ArrowUpIcon, Loader2Icon, LockIcon, SendIcon, Trash2Icon } from "lucide-react"

export function SegmentEditor({ assignment, section, slots: initial, existingIds, nodes, paperTitle }) {
  const router = useRouter()
  const [slots, setSlots] = useState(initial) // [{pos, item|null}]，长度 = 区间长度
  const [token, setToken] = useState(assignment.updated_us)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  // 提交确认框**要受控**：动作是异步的（先静默保存再提交），不控制开关的话
  // AlertDialogAction 里的 preventDefault 会让它提交完还杵在屏幕上。
  const [confirmOpen, setConfirmOpen] = useState(false)
  const locked = assignment.state === "submitted" || assignment.state === "locked"
  const chip = assignmentStateChip(assignment.state)

  function mutate(next) {
    setSlots(next)
    setDirty(true)
  }

  function addFromBank(row) {
    const index = slots.findIndex((s) => !s.item)
    if (index < 0) {
      toast.error(`这一段只有 ${slots.length} 个位置，先移除一道再加`)
      return
    }
    const next = slots.slice()
    next[index] = {
      pos: slots[index].pos,
      item: {
        question_id: row.question_id,
        question_version_id: row.question_version_id ?? row.version_id ?? row.id,
        content: row.content,
      },
    }
    mutate(next)
  }

  function removeAt(index) {
    const next = slots.slice()
    next[index] = { pos: slots[index].pos, item: null }
    mutate(next)
  }

  function move(index, delta) {
    const target = index + delta
    if (target < 0 || target >= slots.length) return
    // 只和**同段内**的槽位换位置；空位也能换（等于把题往后挪一格）
    const next = slots.slice()
    const a = next[index]
    next[index] = next[target]
    next[target] = a
    mutate(next)
  }

  function payload() {
    return slots
      .filter((s) => s.item)
      .map((s) => ({
        question_id: s.item.question_id,
        question_version_id: s.item.question_version_id,
        origin: "bank",
      }))
  }

  async function save({ silent = false } = {}) {
    setBusy(true)
    const { data, error } = await createClient().rpc("save_paper_assignment", {
      p_assignment_id: assignment.id,
      p_items: payload(),
      p_expected_us: token,
    })
    setBusy(false)
    if (error) {
      toast.error(
        error.code === "40001"
          ? "这一段在别处被改过（或另一个标签页在编辑），请刷新页面后重试"
          : error.message
      )
      return false
    }
    if (data?.assignment_us) setToken(data.assignment_us)
    setDirty(false)
    if (!silent) toast.success("已保存")
    router.refresh()
    return true
  }

  async function submit() {
    if (dirty && !(await save({ silent: true }))) return
    setBusy(true)
    const { error } = await createClient().rpc("submit_paper_assignment", {
      p_assignment_id: assignment.id,
    })
    setBusy(false)
    setConfirmOpen(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("这段已提交（交了即锁），等创始人确认")
    router.refresh()
  }

  const picked = slots.filter((s) => s.item).length
  // 选题器的"已在卷内"要**带上刚挑的**：只给服务端快照那一份的话，同一道题能点两次，
  // 保存时撞 (paper_version_id, question_id) 唯一索引才报错（真机上撞过一次）。
  const usedIds = new Set([
    ...existingIds,
    ...slots.filter((s) => s.item).map((s) => s.item.question_id),
  ])

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* 左栏：题库选题器（与组卷编辑器同一个组件，只是只有一个目标大题） */}
      <aside className="flex min-h-0 flex-col gap-2">
        <p className="text-sm font-medium">从题库挑题</p>
        <div className="min-h-0 flex-1">
          {locked ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              这一段已提交（交了即锁），要改请联系创始人解锁。
            </p>
          ) : (
            <QuestionPicker
              nodes={nodes}
              targetSections={[{ key: String(section.sort_order), title: section.title }]}
              targetSectionKey={String(section.sort_order)}
              onTargetSectionChange={() => {}}
              onAdd={addFromBank}
              existingIds={usedIds}
            />
          )}
        </div>
      </aside>

      {/* 右栏：我的槽位 */}
      <section className="space-y-3">
        <div className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-xs ${chip.cls}`}>{chip.text}</span>
            <span className="text-sm font-medium">{paperTitle}</span>
            <span className="text-sm text-muted-foreground">
              {section.title || `第 ${section.sort_order} 大题`} · 第 {assignment.from_qno}~
              {assignment.to_qno} 题
            </span>
            <Badge variant="outline" className="text-xs">
              {segmentProgress({ ...assignment, item_count: picked })}
            </Badge>
          </div>
          {assignment.note && (
            <p className="mt-1 text-xs text-muted-foreground">创始人说明：{assignment.note}</p>
          )}
        </div>

        <ul className="space-y-2">
          {slots.map((slot, index) => {
            const mine = slot.item
            return (
              <li key={slot.pos} className="rounded-xl border bg-card p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium tabular-nums">
                    第 {slot.pos} 题
                  </span>
                  <span className="text-xs text-muted-foreground">（大题内序号）</span>
                  {mine ? (
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={locked || busy || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUpIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={locked || busy || index === slots.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDownIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={locked || busy}
                        onClick={() => removeAt(index)}
                      >
                        <Trash2Icon className="size-3.5" /> 移除
                      </Button>
                    </div>
                  ) : (
                    <span className="ml-auto text-xs text-muted-foreground">
                      空位 · 从左边挑一道放进来
                    </span>
                  )}
                </div>
                {mine ? (
                  // showAnswer=false：挑题时看题面即可（要答案得等入库后走讲评/成绩单，
                  // 与组卷编辑器一致 —— 那里也不给答案）
                  <QuestionView qtype={mine.qtype ?? "single_choice"} content={mine.content} />
                ) : (
                  <div className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                    （空位）
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={locked || busy || !dirty} onClick={() => save()}>
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            保存这一段
          </Button>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger
              render={
                <Button variant="outline" disabled={locked || busy || picked === 0}>
                  <SendIcon className="size-4" /> 提交这段
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>提交「第 {assignment.from_qno}~{assignment.to_qno} 题」？</AlertDialogTitle>
                <AlertDialogDescription>
                  已挑 {picked} 道题。提交后这一段就锁上了，你自己不能再改 ——
                  要改得找创始人解锁。目标分 {Number(assignment.score ?? 0)} 分只是参考，不会拦提交。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>再改改</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault()
                    submit()
                  }}
                >
                  {busy && <Loader2Icon className="size-4 animate-spin" />}
                  确认提交
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {locked && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <LockIcon className="size-3.5" /> 已提交：要改请联系创始人解锁
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
