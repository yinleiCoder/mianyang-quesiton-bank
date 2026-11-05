// 科学抽题算法动画：只读展示页。
// 讲 FSRS-6 与 BKT 怎么决定「今天练什么」，动画在上、详细解释在下。
// 内容写死在 lib/showcase-scheduler*.js，不接收用户输入、不执行外部代码；
// 与 2026-10-09 撤掉的「教师写动画」不是同一个功能。
import { requireUser } from "@/lib/auth"
import { PageHeader } from "@/components/page-header"
import { SchedulerPlayerLazy } from "@/components/showcase/scheduler/scheduler-player-lazy"
import { SchedulerExplainer } from "@/components/showcase/scheduler/scheduler-explainer"

export const metadata = { title: "科学抽题算法动画" }

export default async function ShowcaseSchedulerPage() {
  await requireUser()
  return (
    <div className="space-y-6">
      <PageHeader
        title="科学抽题算法动画"
        description="FSRS-6 决定「什么时候该复习」，BKT 决定「哪里薄弱」，40/30/10 配额决定「一次练习怎么拼」。动画里的每个数字都由生产同款公式现算，下方附详细解释与边界说明。"
      />
      <SchedulerPlayerLazy />
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">详细解释</h2>
        <p className="text-sm text-muted-foreground">
          算法口径以迁移 0122 / 0125 / 0126 为准；这里写的是实现，不是教科书版本。
        </p>
        <SchedulerExplainer />
      </section>
    </div>
  )
}
