"use client"

// 试卷详情页的操作区。按状态与身份决定出现哪些按钮——
// 这只是"少给错误的按钮"，**不替代服务端校验**：每个 RPC 自己会再断言一次。
import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { PencilIcon, SendIcon, UndoIcon, Trash2Icon, GitBranchIcon, RefreshCwIcon } from "lucide-react"

export function PaperActions({ paperId, versionId, status, isOwner, isTeacher, hasInFlight, canDelete, healthCount }) {
  const router = useRouter()
  const supabase = createClient()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(null)

  async function call(fn, args, okMsg, redirect) {
    setBusy(true)
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    setConfirming(null)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(okMsg)
    if (redirect) router.push(redirect)
    else router.refresh()
  }

  const canEdit = isTeacher && isOwner && (status === "draft" || status === "returned")
  const canSubmit = isTeacher && isOwner && (status === "draft" || status === "returned")
  const canRetract = isOwner && (status === "pending_group" || status === "pending_city")
  // 能不能删由页面上算好传进来（判据在服务端：没人考过 + 没有在审任务，见 0091）。
  // 这里不再自己拿 status 猜——旧口径"只有纯草稿能删"正是用户报的那个 bug。
  const canRevise = isTeacher && isOwner && status === "published" && !hasInFlight

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canEdit && (
        <Button nativeButton={false} render={<Link href={`/papers/edit/${versionId}`} />}>
          <PencilIcon className="size-4" /> 编辑卷面
        </Button>
      )}
      {canSubmit && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setConfirming("submit")}
        >
          <SendIcon className="size-4" /> 提交审核
        </Button>
      )}
      {canRetract && (
        <Button variant="outline" disabled={busy} onClick={() => setConfirming("retract")}>
          <UndoIcon className="size-4" /> 撤回
        </Button>
      )}
      {canRevise && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => call("create_paper_edit_draft", { p_paper_id: paperId }, "已创建改版草稿")}
        >
          <GitBranchIcon className="size-4" /> 发起改版
        </Button>
      )}
      {healthCount > 0 && canEdit && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => call("paper_refresh_items", { p_version_id: versionId }, "已刷新到题库最新版本")}
        >
          <RefreshCwIcon className="size-4" /> 刷新题目
        </Button>
      )}
      {canDelete && (
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => setConfirming("delete")}
        >
          <Trash2Icon className="size-4" /> 删除
        </Button>
      )}

      {confirming === "submit" && (
        <ConfirmDialog
          title="提交审核？"
          description="提交后卷面会被锁定，需经教研组长与市级专家两级审核。审核期间如需修改请先撤回。"
          confirmText="提交"
          busy={busy}
          onClose={() => setConfirming(null)}
          onConfirm={() => call("submit_paper", { p_version_id: versionId }, "已提交审核")}
        />
      )}
      {confirming === "retract" && (
        <ConfirmDialog
          title="撤回这份试卷？"
          description="撤回后试卷回到你自己的名下，可以继续修改再重新提交，审核流程会从头走一遍。"
          confirmText="撤回"
          busy={busy}
          onClose={() => setConfirming(null)}
          onConfirm={() => call("retract_paper", { p_version_id: versionId }, "已撤回")}
        />
      )}
      {confirming === "delete" && (
        <ConfirmDialog
          title="删除这份试卷？"
          // 文案跟着判据走（0091 起是"没人考过 + 没有在审任务"，不再是"只有纯草稿"）。
          // 说明里点名那两种情况：它们正是会失败的原因，先说清楚比点了再报错强。
          description="删除后无法恢复。已有人考过、或正在审批中的试卷不能删除。"
          confirmText="删除"
          destructive
          busy={busy}
          onClose={() => setConfirming(null)}
          onConfirm={() => call("delete_paper", { p_paper_id: paperId }, "已删除", "/papers")}
        />
      )}
    </div>
  )
}
