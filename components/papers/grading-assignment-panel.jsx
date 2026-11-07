"use client"

// 阅卷分工（0148）：只给试卷作者 / 本校管理员 / 系统管理员。
//
// 默认是公共池认领，这个面板提供的是**可选**的管理动作：把该卷「未认领且待批」
// 的场次按提交时间轮转给能批这一场的老师（排除试卷作者与当前操作人）。
// 不做强制分配；分配后老师仍可释放，管理员也可逐场改派（见阅卷台详情头）。
import { useState } from "react"
import { toast } from "sonner"
import { autoAssignPaper } from "@/lib/grading-assignments"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
import { Loader2Icon, ShuffleIcon, UsersIcon } from "lucide-react"

export function GradingAssignmentPanel({ paperId, onAssigned }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  async function run() {
    setBusy(true)
    const { data, error } = await autoAssignPaper(paperId)
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    setResult(data ?? null)
    if (Number(data?.assigned ?? 0) > 0) {
      toast.success(`已分派 ${data.assigned} 场待认领卷子`)
    } else {
      toast.info(data?.message ?? "没有可分配的场次")
    }
    await onAssigned?.()
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <UsersIcon className="size-4" />
              阅卷分工
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              阅卷资格按「考生所在学校 + 专业」自动推导：本校同专业教师、该科目教研组长/市级专家都可认领；
              未设置任教专业的教师按本校通用阅卷人处理（可在「用户与任命 → 任教专业」补齐）。
              未认领的场次先到先得，认领后由该老师批完整份卷。
            </p>
          </div>

          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="outline" size="sm" disabled={busy}>
                  {busy ? <Loader2Icon className="size-4 animate-spin" /> : <ShuffleIcon className="size-4" />}
                  平均分配待认领卷子
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>把未认领的卷子平均分给阅卷老师？</AlertDialogTitle>
                <AlertDialogDescription>
                  按提交时间轮转分给「能批这一场」的老师，并排除试卷作者与你本人。
                  找不到可批老师的场次会留在公共池，不会丢。分派后老师仍可释放，你也可以逐场改派。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={run} disabled={busy}>
                  确认分配
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {result && (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            本次分派 <b className="tabular-nums text-foreground">{result.assigned ?? 0}</b> 场，
            留在公共池 <b className="tabular-nums text-foreground">{result.skipped ?? 0}</b> 场
            {Array.isArray(result.by_grader) && result.by_grader.length > 0
              ? `：${result.by_grader
                  .map((row) => `${row.name || "（已注销）"} ${row.count} 场`)
                  .join("、")}`
              : ""}
            {result.message ? `（${result.message}）` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
