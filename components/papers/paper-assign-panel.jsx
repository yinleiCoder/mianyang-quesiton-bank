"use client"

// 协同组卷 · 创始人面板（0085）。三件事在同一屏上：
//   ① 划任务：选大题 → 填题号区间 → 填目标分 → 选老师
//   ② 各段状态一屏铺开（这就是设计文档说的"合卷视图"）
//   ③ 收回 / 解锁 / 确认
//
// 口径：分派记的是「大题序号 + **大题内部**的第 X~Y 题」（不是全卷题号）；
// score 只是显示用的目标，服务端不硬校验（用户 2026-10-04 口径）。
//
// 收回**不删记录**：题目归还创始人、那一行挂回创始人名下并回 open —— 于是
// "谁什么时候被分派过、又什么时候被收回"查得到，同一区间以后还能再分出去。
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { assignmentStateChip, loadPaperAssignments, segmentProgress } from "@/lib/paper-assignments"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { CheckIcon, Loader2Icon, LockOpenIcon, PlusIcon, UndoIcon, UsersIcon } from "lucide-react"

export function PaperAssignPanel({ versionId, sections, candidates, assignments: initial }) {
  const router = useRouter()
  const [list, setList] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [sectionOrd, setSectionOrd] = useState(String(sections[0]?.sort_order ?? 1))
  const [fromQno, setFromQno] = useState("1")
  const [toQno, setToQno] = useState("1")
  const [score, setScore] = useState("0")
  const [assignee, setAssignee] = useState(null)
  const [note, setNote] = useState("")

  async function refresh() {
    // **必须看 error**：RPC 失败时 data 是 null，静默忽略就会让列表停在旧数据上
    // （真机上撞过一次：写入成功、toast 说"已分派"，列表却还是空的）。
    const { assignments, error } = await loadPaperAssignments(createClient(), versionId)
    if (error) {
      toast.error(`分派清单没取回来：${error.message}`)
      return
    }
    setList(assignments)
  }

  async function run(fn, params, msg) {
    setBusy(true)
    const { error } = await createClient().rpc(fn, params)
    setBusy(false)
    if (error) {
      // 服务端的中文守卫逐字透出（区间重叠、已经有人在做了、越过别人的区间…）
      toast.error(error.message)
      return false
    }
    toast.success(msg)
    await refresh()
    router.refresh()
    return true
  }

  async function handleAssign(e) {
    e.preventDefault()
    if (!assignee) return
    const ok = await run(
      "assign_paper_sections",
      {
        p_version_id: versionId,
        p_assignments: [
          {
            section_ord: Number(sectionOrd),
            from_qno: Number(fromQno),
            to_qno: Number(toQno),
            score: Number(score) || 0,
            assignee_id: assignee,
            note: note.trim() || null,
          },
        ],
      },
      "已分派"
    )
    if (ok) {
      setNote("")
      setAssignee(null)
    }
  }

  const counts = list.reduce(
    (acc, a) => {
      acc[a.state] = (acc[a.state] ?? 0) + 1
      acc.picked += Number(a.item_count ?? 0)
      acc.cap += a.to_qno - a.from_qno + 1
      return acc
    },
    { open: 0, claimed: 0, submitted: 0, locked: 0, picked: 0, cap: 0 }
  )

  return (
    <div className="space-y-4">
      {/* ---------- 划任务 ---------- */}
      <form onSubmit={handleAssign} className="rounded-xl border bg-card p-4">
        <p className="mb-3 text-sm font-medium">划一段任务</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="as-section">大题</Label>
            <Select value={sectionOrd} onValueChange={setSectionOrd}>
              <SelectTrigger id="as-section" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sections.map((s) => (
                  <SelectItem key={s.sort_order} value={String(s.sort_order)}>
                    {s.seq_label ? `第${s.seq_label}大题 · ` : ""}
                    {s.title || "（未命名）"}（{s.item_count} 题）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="as-from">第几题起</Label>
            <Input
              id="as-from"
              type="number"
              min={1}
              className="w-24"
              value={fromQno}
              onChange={(e) => setFromQno(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="as-to">到第几题</Label>
            <Input
              id="as-to"
              type="number"
              min={1}
              className="w-24"
              value={toQno}
              onChange={(e) => setToQno(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="as-score">目标分</Label>
            <Input
              id="as-score"
              type="number"
              min={0}
              step="0.5"
              className="w-24"
              value={score}
              onChange={(e) => setScore(e.target.value)}
            />
          </div>
          <div className="grid min-w-56 flex-1 gap-1.5">
            <Label htmlFor="as-assignee">分给</Label>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger id="as-assignee">
                <SelectValue placeholder="选择老师" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.user_id} value={c.user_id}>
                    {c.name}
                    {c.school_name ? `（${c.school_name}）` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid min-w-48 flex-1 gap-1.5">
            <Label htmlFor="as-note">说明（可选）</Label>
            <Input
              id="as-note"
              maxLength={100}
              placeholder="如：考 CAD 基础操作"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || !assignee}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
            分派
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          题号按大题内部数（「第一大题 第 3~7 题」）。目标分只用于显示进度，不硬校验；
          区间不能和已有的重叠。
        </p>
      </form>

      {/* ---------- 合卷视图 ---------- */}
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
          还没有分派。上面划一段任务，被指派的老师就能在他们那几段里挑题了。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <UsersIcon className="size-4" />
              共 {list.length} 段
            </span>
            <span>
              已挑 {counts.picked}/{counts.cap} 题
            </span>
            <span>编辑中 {counts.claimed}</span>
            <span>已交 {counts.submitted + counts.locked}</span>
            <span>待认领 {counts.open}</span>
          </div>

          <ul className="space-y-2">
            {list.map((a) => {
              const chip = assignmentStateChip(a.state)
              return (
                <li key={a.id} className="rounded-xl border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${chip.cls}`}>{chip.text}</span>
                    <span className="text-sm font-medium">
                      {a.section_title || `第 ${a.section_ord} 大题`}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      第 {a.from_qno}~{a.to_qno} 题
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {segmentProgress(a)}
                    </Badge>
                    <span className="ml-auto text-sm">
                      {a.assignee_name ?? "（账号已注销）"}
                    </span>
                  </div>
                  {a.note && (
                    <p className="mt-1 text-xs text-muted-foreground">说明：{a.note}</p>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
                    {(a.state === "submitted" || a.state === "locked") ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          run("set_paper_assignment_state", { p_assignment_id: a.id, p_state: "claimed" },
                            "已解锁，可以再改")
                        }
                      >
                        <LockOpenIcon className="size-3.5" /> 解锁让他再改
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || a.state !== "submitted"}
                        onClick={() =>
                          run("set_paper_assignment_state", { p_assignment_id: a.id, p_state: "locked" },
                            "已确认")
                        }
                      >
                        <CheckIcon className="size-3.5" /> 确认这段
                      </Button>
                    )}

                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button variant="ghost" size="sm" disabled={busy}>
                            <UndoIcon className="size-3.5" /> 收回
                          </Button>
                        }
                      />
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            收回「{a.section_title || `第 ${a.section_ord} 大题`} 第 {a.from_qno}~{a.to_qno} 题」？
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            这段已挑的 {a.item_count} 道题留在卷子上、归还给你（不再挂在
                            {a.assignee_name ?? "对方"}名下），这一段变回「没分出去」。
                            以后可以把同一个区间再分给别人。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
                          <AlertDialogAction
                            disabled={busy}
                            onClick={(e) => {
                              e.preventDefault()
                              run("revoke_paper_assignment", { p_assignment_id: a.id }, "已收回")
                            }}
                          >
                            {busy && <Loader2Icon className="size-4 animate-spin" />}
                            确认收回
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </li>
              )
            })}
          </ul>

          <p className="text-xs text-muted-foreground">
            交了即锁：被指派人点「提交这段」之后不能再改，要改先解锁。
            这一段有题在途时，整卷保存会被拒绝（否则会连带删掉别人正在写的东西）——
            那时用「逐段编辑」，或把段收回。
          </p>
        </>
      )}
    </div>
  )
}
