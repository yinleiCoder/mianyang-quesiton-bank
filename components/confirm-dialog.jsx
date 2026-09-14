"use client"

import { Loader2Icon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

// 通用确认对话框：标题 + 说明 + 确认/取消；busy 时禁用并显示加载图标。
// 用法是「条件挂载」——父层写 {open && <ConfirmDialog … />}，不要常挂载再传 open：
// 常挂载时 React Compiler 记忆化的闭包会在空数据上做缓存比较（见 my-questions 的原注释）。
export function ConfirmDialog({
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  destructive = false,
  busy = false,
  onConfirm,
  onClose,
}) {
  return (
    <AlertDialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription className="whitespace-pre-wrap">
              {description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className={destructive ? "bg-destructive hover:bg-destructive/90" : undefined}
            onClick={(e) => {
              e.preventDefault()
              onConfirm()
            }}
          >
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
