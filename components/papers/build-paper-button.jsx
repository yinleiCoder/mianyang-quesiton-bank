"use client"

// 「一键成卷」：把 AI 解析出来的整卷，变成一份可编辑的试卷草稿。
//
// 顺序是刻意的，不能反：
//   1. 先把勾选的题逐片 import_questions_draft 变成**题库草稿**（每片 ≤25，逐题子事务）；
//   2. 再把已入库的题通过 import_build_paper 装进卷面。
// 题目照旧走题库那条路（草稿 → 两级审核 → 入库），试卷只引用它们。
// 所以刚成卷时卷面上的题都标着「未入库」，**提交试卷会被服务端拦下**，
// 直到这些题真的入了库——「只能使用题库中的题目」这条要求不会被 AI 路径绕过。
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { SparklesIcon, Loader2Icon } from "lucide-react"

const CHUNK = 25

export function BuildPaperButton({ job, items, keptIds, onRefresh }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [confirming, setConfirming] = useState(false)

  const alreadyImported = items.filter((i) => i.status === "imported").length
  const target = (job.paper_meta ?? {}).title || job.title

  async function build() {
    setConfirming(false)
    setBusy(true)
    setProgress({ done: 0, total: keptIds.length })
    const supabase = createClient()
    try {
      // ---- 1) 先把要用的题入库成草稿 ----
      const importedIds = new Set(items.filter((i) => i.status === "imported").map((i) => i.id))
      for (let i = 0; i < keptIds.length; i += CHUNK) {
        const chunk = keptIds.slice(i, i + CHUNK)
        const { data, error } = await supabase.rpc("import_questions_draft", {
          p_job_id: job.id,
          p_item_ids: chunk,
        })
        if (error) {
          toast.error(error.message)
          setBusy(false)
          setProgress(null)
          return
        }
        for (const r of data ?? []) if (r.ok) importedIds.add(r.item_id)
        setProgress({ done: Math.min(i + CHUNK, keptIds.length), total: keptIds.length })
      }

      if (importedIds.size === 0) {
        toast.error("没有已入库的题目可成卷，请先勾选题目并入库")
        return
      }

      // ---- 2) 组装卷面 ----
      const { data, error } = await supabase.rpc("import_build_paper", {
        p_job_id: job.id,
        p_item_ids: [...importedIds],
        p_paper_version_id: null, // null = 新建一份卷；要追加到已有草稿时传它的 version_id
        p_meta: {},
      })
      if (error) {
        toast.error(error.message)
        return
      }

      await onRefresh?.()
      const warn = data.warnings ?? []
      toast.success(`已还原 ${data.sections?.length ?? 0} 个大题、${data.added} 道题`)
      if (warn.length > 0) {
        // 提醒不弹 toast 而是放长一点：教师需要在进编辑器前就知道哪儿要手工补
        toast.warning(warn[0], { duration: 8000 })
      }
      router.push(`/papers/edit/${data.paper_version_id}`)
    } catch (err) {
      toast.error(err?.message ?? "成卷失败")
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setConfirming(true)} disabled={busy}>
        {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SparklesIcon className="size-4" />}
        {busy && progress ? `成卷中 ${progress.done}/${progress.total}` : "一键成卷"}
      </Button>

      {confirming && (
        <ConfirmDialog
          title="把解析结果还原成一份试卷？"
          description={
            `将创建试卷草稿「${target}」，并按解析出的大题与分值排好卷面。\n\n` +
            `• 这次会先把勾选的 ${keptIds.length} 道题入库成「我的题目」里的草稿` +
            (alreadyImported > 0 ? `（另有 ${alreadyImported} 道之前已入库）` : "") +
            `\n• 题目仍需走两级审核才能真正入库；在那之前这份试卷不能提交\n` +
            `• 分值若没抽准，可以在组卷编辑器里逐题改`
          }
          confirmText="开始成卷"
          busy={busy}
          onClose={() => setConfirming(false)}
          onConfirm={build}
        />
      )}
    </>
  )
}
