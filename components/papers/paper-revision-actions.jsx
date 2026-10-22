"use client"

// 已入库试卷的"改版草稿"操作条：编辑 / 删除改版 / 撤回改版。
// 与整卷删除（PaperActions 里的「删除」）分开：这里删的只是未入库的改版，
// 已入库版本和考试记录都不受影响。
import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { PencilIcon, Trash2Icon, UndoIcon } from "lucide-react"

export function PaperRevisionActions({ versionId, status }) {
  const router = useRouter()
  const supabase = createClient()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(null)
  const editable = status === "draft" || status === "returned"
  const pending = status === "pending_group" || status === "pending_city"

  async function call(fn, args, okMsg) {
    setBusy(true)
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    setConfirming(null)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(okMsg)
    router.refresh()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {editable && (
        <Button
          size="sm"
          nativeButton={false}
          render={<Link href={`/papers/edit/${versionId}`} />}
        >
          <PencilIcon className="size-4" /> 编辑卷面
        </Button>
      )}
      {pending && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setConfirming("retract")}
        >
          <UndoIcon className="size-4" /> 撤回改版
        </Button>
      )}
      {editable && (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => setConfirming("delete")}
        >
          <Trash2Icon className="size-4" /> 删除改版草稿
        </Button>
      )}

      {confirming === "retract" && (
        <ConfirmDialog
          title="撤回这次改版？"
          description="撤回后改版回到草稿，可以继续编辑再重新提交；审核流程会从头走一遍。已入库版本不受影响。"
          confirmText="撤回"
          busy={busy}
          onClose={() => setConfirming(null)}
          onConfirm={() => call("retract_paper", { p_version_id: versionId }, "已撤回改版")}
        />
      )}
      {confirming === "delete" && (
        <ConfirmDialog
          title="删除这份改版草稿？"
          description="只删除这份尚未入库的改版，已入库版本与考试记录都不受影响。删除后无法恢复。"
          confirmText="删除"
          destructive
          busy={busy}
          onClose={() => setConfirming(null)}
          onConfirm={() =>
            call("delete_paper_version", { p_version_id: versionId }, "已删除改版草稿")
          }
        />
      )}
    </div>
  )
}
