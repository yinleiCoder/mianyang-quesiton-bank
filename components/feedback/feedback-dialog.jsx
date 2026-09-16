"use client"

// 意见反馈弹窗（侧栏底部菜单入口，任意登录用户可用）。
// 提交走 submit_feedback RPC（客户端无 DML，见 0033）；成功后只回一个短编号——
// 本功能没有回复闭环，「已处理」状态提交人看不到，所以文案必须把预期说清楚。
// 挂载方式遵循 ConfirmDialog 的条件挂载约定：父层写 {open && <FeedbackDialog … />}。
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { FEEDBACK_CATEGORIES } from "@/lib/feedback"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { Loader2Icon } from "lucide-react"

const MIN_LEN = 5

export function FeedbackDialog({ onClose }) {
  const router = useRouter()
  const [category, setCategory] = useState("bug")
  const [content, setContent] = useState("")
  const [contact, setContact] = useState("")
  const [busy, setBusy] = useState(false)

  const length = content.trim().length
  const tooShort = length < MIN_LEN

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy || tooShort) return
    setBusy(true)
    const { data, error } = await createClient().rpc("submit_feedback", {
      p_category: category,
      p_content: content.trim(),
      p_contact: contact.trim() || null,
      p_platform: "web",
    })
    setBusy(false)
    if (error) {
      // RPC 的中文校验/限流报错逐字透出（「提交太频繁了，请稍后再试」等）
      toast.error(error.message)
      return
    }
    toast.success(`已提交，编号 ${String(data).slice(0, 8)}`)
    onClose()
    // 管理员自己提交时，侧栏未处理角标要跟着动
    router.refresh()
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>意见反馈</DialogTitle>
            <DialogDescription>
              使用网页端或刷题 App 时遇到的功能问题、改进建议，都可以在这里告诉系统管理员。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="feedback-category">反馈类型</Label>
            <select
              id="feedback-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
            >
              {Object.entries(FEEDBACK_CATEGORIES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="feedback-content">问题描述</Label>
            <Textarea
              id="feedback-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              minRows={5}
              maxLength={2000}
              placeholder="例如：题库按「计算机类」筛选后翻到第二页，会跳回第一页。"
            />
            <p className="text-xs text-muted-foreground">
              至少 {MIN_LEN} 个字 · 已写 {length}/2000
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="feedback-contact">联系方式（选填）</Label>
            <Input
              id="feedback-contact"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              maxLength={60}
              placeholder="手机号 / 微信 / QQ"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            提交后由系统管理员查看，不在这里回复；需要跟进的会通过你留的联系方式联系你。
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
