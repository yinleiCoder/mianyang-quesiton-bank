"use client"

// 右栏属性面板的小字段壳：标签 + 控件 + 一行提示。
import { Label } from "@/components/ui/label"

export function Field({ label, hint, children }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
