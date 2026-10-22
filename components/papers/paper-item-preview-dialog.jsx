"use client"

// 卷面卡片的「题干预览」。用对话框而不是把内容塞进卡片：复合题/材料题可以很长，
// 全部展开会把几十道题的画面拉成一条长带；对话框还能让教师顺手核对答案与解析。
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { QuestionView } from "@/components/questions/question-view"
import { qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { EyeIcon } from "lucide-react"

export function PaperItemPreviewDialog({ item, compact = false }) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className={
              compact
                ? "size-6 shrink-0"
                : "ml-auto h-6 px-1.5 text-xs text-primary"
            }
            title="预览完整题干、选项与答案"
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <EyeIcon className="size-3.5" />
        {!compact && " 题干预览"}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {item.seq ? `第 ${item.seq} 题` : "题干预览"}
            <Badge variant="secondary" className="font-normal">
              {qtypeLabel(item.qtype)}
            </Badge>
            <span className="text-xs font-normal text-muted-foreground">
              难度 {difficultyLabel(item.difficulty)}
            </span>
          </DialogTitle>
        </DialogHeader>
        <QuestionView qtype={item.qtype} content={item.content} showAnswer />
      </DialogContent>
    </Dialog>
  )
}
