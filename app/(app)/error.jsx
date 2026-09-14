"use client"

// 受保护区的错误边界：页面/工作台装载失败（多为 Supabase 查询报错）时给出可重试的提示，
// 而不是框架默认的 500。按 Next 16 约定，错误边界必须是客户端组件，重试函数叫 retry。
// 注：error.jsx 不包住同段的 layout，app/(app)/layout.jsx 自身的错误会继续上抛（见 app/global-error.jsx）。
import { useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TriangleAlertIcon } from "lucide-react"

export default function AppError({ error, retry }) {
  useEffect(() => {
    // 生产环境下 error.message 是通用文案，靠 digest 与服务端日志对照
    console.error("页面渲染失败", error)
  }, [error])

  return (
    <div className="flex flex-1 items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <TriangleAlertIcon className="size-6 text-destructive" />
          </div>
          <CardTitle className="text-lg">页面加载失败</CardTitle>
          <CardDescription>
            数据查询或渲染时出错，可能是网络波动或会话过期。可重试一次；若反复失败请联系系统管理员。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3 pb-6">
          <div className="flex gap-2">
            <Button onClick={() => retry()}>重试</Button>
            <Button variant="outline" nativeButton={false} render={<Link href="/dashboard" />}>
              返回工作台
            </Button>
          </div>
          {error?.digest && (
            <p className="text-xs text-muted-foreground">错误标识：{error.digest}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
