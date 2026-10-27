"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PromoPlayerLazy } from "./promo-player-lazy"

export function SoftwarePromoShowcase() {
  return (
    <Tabs defaultValue="web" className="gap-3">
      <TabsList className="w-full max-w-lg">
        <TabsTrigger value="web">网页出题</TabsTrigger>
        <TabsTrigger value="windows">Windows 客户端</TabsTrigger>
        <TabsTrigger value="android">Android 客户端</TabsTrigger>
      </TabsList>

      <TabsContent value="web" className="space-y-3">
        <PromoPlayerLazy platform="web" />
      </TabsContent>

      <TabsContent value="windows" className="space-y-3">
        <PromoPlayerLazy platform="windows" />
      </TabsContent>

      <TabsContent value="android" className="space-y-3">
        <PromoPlayerLazy platform="android" />
      </TabsContent>

      <p className="text-xs text-muted-foreground">
        网页：出题 / 审批 / 组卷 / 讲评；软件：刷题 / 考试 / 错题 / 排行 / 复习。三条动画都按真实使用流程编排：
        网页教师端从工作台到讲评，Windows / Android 从登录到我的。
      </p>
    </Tabs>
  )
}
