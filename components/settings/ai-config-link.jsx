"use client"

// 统一的「AI 配置」入口：所有功能页只显示一行状态，不再各自内嵌设置面板。
//
// 为什么带 dialog 模式：导入向导/导入运行页的状态很长（文件、页码、解析进度），
// 跳到设置页再回来会丢；在弹窗里保存后 onParentChange 原地刷新即可。
import { useState } from "react"
import Link from "next/link"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { DeepSeekSettingsPanel } from "@/components/import/deepseek-settings-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CheckCircle2Icon, KeyRoundIcon } from "lucide-react"

function SettingsDialog({ open, onOpenChange, onChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>AI 配置</DialogTitle>
        </DialogHeader>
        <DeepSeekSettingsPanel purpose="settings" onChange={onChange} />
      </DialogContent>
    </Dialog>
  )
}

export function AiConfigLink({
  dialog = false,
  compact = false,
  onChange,
  className = "",
}) {
  const { masked, model, ready, refresh } = useDeepSeekPrefs()
  const [open, setOpen] = useState(false)

  if (!ready) {
    return <div className={`h-9 animate-pulse rounded-lg border bg-muted/40 ${className}`} />
  }

  const afterChange = () => {
    refresh()
    onChange?.()
  }
  const pad = compact ? "px-2 py-1.5" : "px-3 py-2"

  // 行内紧凑模式：只出一个按钮，弹窗保存；适合阅卷台/审题面板这类不能丢状态的页面。
  if (compact) {
    return (
      <>
        {masked ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
            AI 已配置 · 修改
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            配置 AI 密钥
          </Button>
        )}
        <SettingsDialog open={open} onOpenChange={setOpen} onChange={afterChange} />
      </>
    )
  }

  if (masked) {
    return (
      <div
        className={`flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 text-xs text-emerald-900 ${pad} ${className}`}
      >
        <CheckCircle2Icon className="size-3.5 shrink-0" />
        <span>
          AI 已配置（{masked}）· 模型 <b>{model}</b>
        </span>
        {dialog ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
            修改
          </Button>
        ) : (
          <Link href="/settings/ai" className="font-medium underline-offset-2 hover:underline">
            修改
          </Link>
        )}
        {dialog && <SettingsDialog open={open} onOpenChange={setOpen} onChange={afterChange} />}
      </div>
    )
  }

  return (
    <div
      className={`rounded-lg border border-amber-300 bg-amber-50/60 text-xs text-amber-900 ${pad} ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <KeyRoundIcon className="size-3.5 shrink-0" />
        <span className="font-medium">尚未配置 AI 密钥</span>
        {dialog ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            去配置
          </Button>
        ) : (
          <Link href="/settings/ai" className="font-medium underline-offset-2 hover:underline">
            去配置
          </Link>
        )}
        <span className="text-amber-800">只存本机浏览器，所有 AI 功能共用</span>
      </div>
      {dialog && <SettingsDialog open={open} onOpenChange={setOpen} onChange={afterChange} />}
    </div>
  )
}
