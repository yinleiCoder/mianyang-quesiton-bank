"use client"

// 卷面卡片里"展开题干"的就地预览。单独成文件：卡片本身还要管拖拽、排序与分值按钮，
// 把题目渲染塞进去会让它继续膨胀（架构检查按行数看着）。
import { QuestionView } from "@/components/questions/question-view"

export function PaperItemPreview({ qtype, content }) {
  return (
    // 卡片点击是"选中"，点内容里的图片/链接不该顺带选中
    <div
      className="mt-2 rounded-md border bg-muted/20 p-2.5 text-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <QuestionView qtype={qtype} content={content} showAnswer />
    </div>
  )
}
