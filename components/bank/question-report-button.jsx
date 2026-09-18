"use client"

// 题目纠错入口：题库详情页上的一个旗标按钮 + 提交弹窗。
//
// 与通用意见反馈（components/feedback/feedback-dialog.jsx）的区别，文案上必须说清：
//   · 收件人是**本题作者**，不是系统管理员；
//   · **有回复闭环** —— 作者处理时会写一句说明，提交人在题目页上能看到。
// 这两点决定了这里不能照抄那句"不在这里回复"，否则学生会以为又是石沉大海。
//
// 挂载方式遵循本仓的条件挂载约定：父层写 {open && <QuestionReportDialog … />}。
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { REPORT_CATEGORIES } from "@/lib/question-reports"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FlagIcon, Loader2Icon } from "lucide-react"

// 与服务端 0066 的 check 约束（btrim 后 2–500）对齐。
// 下限 2 是拦"？""。"这种没有信息量的提交 —— 作者收到一个字也没法审。
const MIN_LEN = 2
const MAX_LEN = 500

export function QuestionReportButton({ questionId, versionId, versionNo, disabled }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        <FlagIcon className="size-4" /> 这题有问题
      </button>
      {open && (
        <QuestionReportDialog
          questionId={questionId}
          versionId={versionId}
          versionNo={versionNo}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function QuestionReportDialog({ questionId, versionId, versionNo, onClose }) {
  const router = useRouter()
  const [category, setCategory] = useState("answer")
  const [content, setContent] = useState("")
  const [busy, setBusy] = useState(false)

  const length = content.trim().length
  const tooShort = length < MIN_LEN

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy || tooShort) return
    setBusy(true)
    const { error } = await createClient().rpc("submit_question_report", {
      p_question_id: questionId,
      p_version_id: versionId,
      p_category: category,
      p_content: content.trim(),
    })
    setBusy(false)
    if (error) {
      // RPC 的中文校验报错逐字透出（「你已经反馈过这道题了，作者还在处理中」等）
      toast.error(error.message)
      return
    }
    toast.success("已发给本题作者，处理结果会显示在这道题下面")
    onClose()
    // 题目页上那块「我的反馈」要跟着出现
    router.refresh()
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>反馈这道题的问题</DialogTitle>
            <DialogDescription>
              反馈会直接发给**本题作者**。作者核对后会写一句处理说明，届时你可以在这道题下方看到。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="report-category">问题类型</Label>
            <select
              id="report-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
            >
              {Object.entries(REPORT_CATEGORIES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="report-content">具体问题</Label>
            <Textarea
              id="report-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              minRows={4}
              maxLength={MAX_LEN}
              placeholder="例如：第二问的答案给的是 B，但按题干条件算出来应该是 C。"
            />
            <p className="text-xs text-muted-foreground">
              说清楚哪里不对，作者才好核对 · 已写 {length}/{MAX_LEN}
            </p>
          </div>

          {/* 版本号要让提交人看见：作者改版之后，这条反馈在作者那边会标成"针对 v3 的"。
              不写出来，学生改天发现题已经变了会以为反馈没被采纳。 */}
          <p className="text-xs text-muted-foreground">
            本次反馈针对当前在线版本 v{versionNo}。题目若之后被改版，这条反馈仍会保留在作者的处理列表里。
          </p>

          <DialogFooter>
            <Button type="submit" disabled={busy || tooShort}>
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              提交反馈
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
