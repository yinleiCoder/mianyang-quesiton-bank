"use client"

// 题库浏览/预览的题目渲染开关：答案与解析默认展开（挑题时需先确认题目本身是否适用），可一键收起。
import * as React from "react"
import { QuestionView } from "@/components/questions/question-view"
import { Button } from "@/components/ui/button"
import { EyeOffIcon, EyeIcon } from "lucide-react"

export function QuestionReader({ qtype, content, defaultShow = true }) {
  const [show, setShow] = React.useState(defaultShow)
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setShow((v) => !v)}>
          {show ? (
            <>
              <EyeOffIcon className="size-3.5" /> 收起答案与解析
            </>
          ) : (
            <>
              <EyeIcon className="size-3.5" /> 展开答案与解析
            </>
          )}
        </Button>
      </div>
      <QuestionView qtype={qtype} content={content} showAnswer={show} />
    </div>
  )
}
