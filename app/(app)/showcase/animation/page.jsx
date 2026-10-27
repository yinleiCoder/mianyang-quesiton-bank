// 软件架构及人员管理动画：只读的编程式动画展示页。
// 内容在代码里写死，不接收用户输入、不执行外部代码；与 2026-10-09 撤掉的
// 「教师写动画 / 上传视频」不是同一个功能（不恢复 teaching_animations、不引入沙箱）。
import { requireUser } from "@/lib/auth"
import { PageHeader } from "@/components/page-header"
import { ShowcaseAnimationPlayerLazy } from "@/components/showcase/animation/showcase-animation-player-lazy"

export const metadata = { title: "软件架构及人员管理动画" }

export default async function ShowcaseAnimationPage() {
  await requireUser()
  return (
    <div className="space-y-4">
      <PageHeader
        title="软件架构及人员管理动画"
        description="编程式动画：架构分层、六类系统角色与职责、两级审批闭环、项目团队分工与业务闭环。内容为写死的展示数据，不接收用户输入、不执行外部代码。"
      />
      <ShowcaseAnimationPlayerLazy />
    </div>
  )
}
