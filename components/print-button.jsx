"use client"

// 打印按钮：只在屏幕上出现（print:hidden），点了直接调浏览器的打印对话框。
// 不自动弹打印框：用户可能只是想先看看这一页排版对不对，自动弹会被当成"页面抽风"。
import { useEffect } from "react"
import { PrinterIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

export function PrintButton({ hint = "在打印对话框里选「另存为 PDF」即可保存" }) {
  // 打印页是独立打开的，标题补一句让打印出来的页眉/文件名带得上题目
  useEffect(() => {
    const prev = document.title
    document.title = "题目打印 · 绵阳市中职共建题库"
    return () => {
      document.title = prev
    }
  }, [])

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 print:hidden">
      <Button type="button" onClick={() => window.print()}>
        <PrinterIcon className="size-4" /> 打印 / 保存为 PDF
      </Button>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  )
}
