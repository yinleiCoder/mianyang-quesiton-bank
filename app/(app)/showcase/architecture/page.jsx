// 软件架构与人员层级管理结构流程图：只读展示页，不读业务数据。
// 画布依赖 @xyflow/react（React Flow v12），两张图用 shadcn Tabs 切换。
import { requireUser } from "@/lib/auth"
import { PageHeader } from "@/components/page-header"
import { ArchitectureShowcase } from "@/components/showcase/architecture-showcase"

export const metadata = { title: "软件架构与人员层级管理结构流程图" }

export default async function ShowcaseArchitecturePage() {
  await requireUser()
  return (
    <div className="space-y-4">
      <PageHeader
        title="软件架构与人员层级管理结构流程图"
        description="两张可缩放、可平移的画布：软件架构从端到数据与交付；人员层级从系统管理员到学生，并标出两级审批链与项目团队岗位。"
      />
      <ArchitectureShowcase />
    </div>
  )
}
