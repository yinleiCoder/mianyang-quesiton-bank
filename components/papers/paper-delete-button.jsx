"use client"

// 组卷库列表里的「删除」按钮。
//
// 为什么是一个独立的小客户端组件、而不是把卡片改成客户端组件：卡片整块是个 <Link>，
// 按钮不能塞进链接里（嵌套可交互元素），也不值得为它把整张卡变成客户端组件。
// 所以在页面那一层排成一行：卡片 | 按钮，两边互不干扰。
//
// 能删的范围与详情页、与 RPC 完全一致：**只有从没提交过审核的纯草稿**。
// 这一层只是"不给出点了会被拒的按钮"，真正的守卫在 delete_paper 里
// （它会断言作者身份与"没有非 draft 版本"）。调用方负责先判断能不能删
// ——见 app/(app)/papers/page.jsx 里那条 canDeletePaper()。
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Loader2Icon, Trash2Icon } from "lucide-react"

export function PaperDeleteButton({ paperId, title }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  async function remove() {
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.rpc("delete_paper", { p_paper_id: paperId })
    setBusy(false)
    setOpen(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("已删除")
    router.refresh()
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        title="删除这份试卷"
        onClick={() => setOpen(true)}
      >
        {busy ? <Loader2Icon className="size-4 animate-spin" /> : <Trash2Icon className="size-4" />}
        删除
      </Button>
      {open && (
        <ConfirmDialog
          title="删除这份试卷？"
          // 文案跟着判据走（0091）：能删的是"没人考过、也没有在审任务"的卷子，
          // 不限于草稿——入库了但没人考过的照样能删，所以不能再写"还没提交过审核"。
          description={`《${title}》删除后无法恢复。已有人考过、或正在审批中的试卷不能删除。`}
          confirmText="删除"
          destructive
          busy={busy}
          onClose={() => setOpen(false)}
          onConfirm={remove}
        />
      )}
    </>
  )
}
