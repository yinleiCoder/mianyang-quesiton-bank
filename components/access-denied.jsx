// 权限不足提示（渲染在 (app) 布局内，页头保留）
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { CircleSlash2Icon } from "lucide-react"

export function AccessDenied({ title = "无权访问", description }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <CircleSlash2Icon className="size-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription>
            {description ?? "当前账号不具备访问该页面的权限；如需调整请联系系统管理员。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center pb-6">
          <Button variant="outline" nativeButton={false} render={<Link href="/dashboard" />}>
            返回工作台
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
