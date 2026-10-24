"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

// 成绩页的自动刷新。
//
// 为什么用 router.refresh() 轮询而不是 Supabase Realtime：
//   · 成绩变化来自两个地方——学生交卷（exam_attempts）与教师判分（exam_answers），
//     要实时就得同时订阅两张表；而 Realtime 的 RLS/复制槽在这个项目里没启用过，
//     为一条榜单开一套新链路，代价远大于收益。
//   · 榜单是几十行文字，服务端 RPC 一次几毫秒；15 秒一次的轮询足够"成绩出来就能看见"。
//   · router.refresh() 会保留客户端状态（展开的题目、滚动位置），不会把正在看的人打断。
//
// 页面隐藏时不刷新（老师切去批卷、回来时再刷），避免后台标签页白烧请求。
export function AutoRefresh({ intervalMs = 15000 }) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(true)
  const [lastAt, setLastAt] = useState(null)

  useEffect(() => {
    setLastAt(new Date())
  }, [])

  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      if (document.visibilityState === "visible") {
        router.refresh()
        setLastAt(new Date())
      }
    }
    const timer = window.setInterval(tick, intervalMs)
    return () => window.clearInterval(timer)
  }, [enabled, intervalMs, router])

  const seconds = Math.max(1, Math.round(intervalMs / 1000))

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
      <span>
        {enabled ? `每 ${seconds} 秒自动刷新` : "自动刷新已暂停"}
        {lastAt && ` · 上次 ${lastAt.toLocaleTimeString("zh-CN", { hour12: false })}`}
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => {
          router.refresh()
          setLastAt(new Date())
        }}
      >
        <RefreshCwIcon className="size-3.5" />
        立即刷新
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => setEnabled((v) => !v)}
      >
        {enabled ? "暂停" : "继续"}自动刷新
      </Button>
    </div>
  )
}
