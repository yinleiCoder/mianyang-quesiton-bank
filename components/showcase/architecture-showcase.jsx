"use client"

// 两张图的切换用 shadcn Tabs（Base UI 版）。Tabs.Panel 默认 keepMounted=false，
// 切换时画布会卸载重挂，React Flow 的 fitView 正好在节点测量后重新计算。
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArchitectureFlow } from "@/components/showcase/architecture/architecture-flow"
import { FlowLegend, RoleRules } from "@/components/showcase/architecture/flow-legend"
import { RolesFlow } from "@/components/showcase/architecture/roles-flow"

export function ArchitectureShowcase() {
  return (
    <Tabs defaultValue="architecture" className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList className="w-full max-w-sm">
          <TabsTrigger value="architecture">软件架构图</TabsTrigger>
          <TabsTrigger value="roles">人员层级图</TabsTrigger>
        </TabsList>
        <p className="text-xs text-muted-foreground md:hidden">双指缩放 / 拖动平移查看完整图</p>
      </div>

      <TabsContent value="architecture" className="space-y-2">
        <ArchitectureFlow />
        <FlowLegend />
      </TabsContent>

      <TabsContent value="roles" className="space-y-2">
        <RolesFlow />
        <RoleRules />
        <FlowLegend />
      </TabsContent>
    </Tabs>
  )
}
