// 讲评教案的展示（模板与 AI 精修共用同一份结构）。
// 纯展示组件：模板/模型都产出 lib/lesson-plan-*.js 校验过的同形 JSON。
import { Badge } from "@/components/ui/badge"

function Section({ title, children }) {
  return (
    <section className="rounded-xl border p-4">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      {children}
    </section>
  )
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

export function LessonPlanView({ plan }) {
  if (!plan) return null
  const meta = plan.meta ?? {}
  const timeline = asArray(plan.timeline)
  const keyPoints = asArray(plan.key_points)
  const differentiation = plan.differentiation ?? {}
  const homework = plan.homework ?? {}
  const exitTicket = plan.exit_ticket ?? {}

  return (
    <div className="space-y-3">
      <div className="rounded-xl border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold">{meta.title ?? "讲评教案"}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {Number(meta.duration_minutes) || 0} 分钟
              {meta.audience ? ` · ${meta.audience}` : ""}
              {meta.prerequisites ? ` · ${meta.prerequisites}` : ""}
            </p>
          </div>
          <Badge variant="secondary">{meta.source === "ai" ? "AI 精修" : "模板"}</Badge>
        </div>
        {plan.caveats && <p className="mt-2 text-xs text-muted-foreground">{plan.caveats}</p>}
      </div>

      <Section title="教学目标">
        <ul className="space-y-1 text-sm">
          {asArray(plan.objectives).map((objective, index) => (
            <li key={index}>
              知识：{objective.knowledge || "—"}；能力：{objective.ability || "—"}；素养：
              {objective.literacy || "—"}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="课堂时间线">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="py-1 pr-2 text-left font-medium">开始</th>
                <th className="py-1 pr-2 text-left font-medium">分钟</th>
                <th className="py-1 pr-2 text-left font-medium">环节</th>
                <th className="py-1 pr-2 text-left font-medium">教师</th>
                <th className="py-1 pr-2 text-left font-medium">学生</th>
                <th className="py-1 text-left font-medium">材料</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((phase, index) => (
                <tr key={index} className="border-b align-top last:border-0">
                  <td className="py-1 pr-2 tabular-nums">{Number(phase.start_min) || 0}′</td>
                  <td className="py-1 pr-2 tabular-nums">{Number(phase.minutes) || 0}</td>
                  <td className="py-1 pr-2 font-medium">{phase.phase}</td>
                  <td className="py-1 pr-2 whitespace-pre-wrap">{phase.teacher}</td>
                  <td className="py-1 pr-2 whitespace-pre-wrap">{phase.students}</td>
                  <td className="py-1 whitespace-pre-wrap">{phase.materials}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="关键题">
        {keyPoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">报告里没有可用的关键题序号。</p>
        ) : (
          <ul className="space-y-2">
            {keyPoints.map((item, index) => (
              <li key={index} className="rounded-lg border p-2 text-sm">
                <p className="font-medium">
                  第 {item.seq} 题 · {item.title}
                </p>
                {item.why && <p className="text-muted-foreground">为什么：{item.why}</p>}
                {item.approach && <p>课堂动作：{item.approach}</p>}
                {item.evidence && (
                  <p className="text-xs text-muted-foreground">依据：{item.evidence}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid gap-3 sm:grid-cols-2">
        <Section title="板书">
          <ul className="space-y-1 text-sm">
            {asArray(plan.board_plan).map((item, index) => (
              <li key={index}>· {item}</li>
            ))}
          </ul>
        </Section>
        <Section title="分层">
          <p className="text-sm">支持：{differentiation.support || "—"}</p>
          <p className="text-sm">核心：{differentiation.core || "—"}</p>
          <p className="text-sm">挑战：{differentiation.challenge || "—"}</p>
        </Section>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Section title="作业">
          <p className="text-xs text-muted-foreground">必做</p>
          <ul className="mb-1 space-y-0.5 text-sm">
            {asArray(homework.must).map((item, index) => (
              <li key={index}>· {item}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">选做</p>
          <ul className="mb-1 space-y-0.5 text-sm">
            {asArray(homework.choose).map((item, index) => (
              <li key={index}>· {item}</li>
            ))}
          </ul>
          {homework.preview && <p className="text-sm">预习：{homework.preview}</p>}
        </Section>
        <Section title="出口票">
          <ul className="space-y-1 text-sm">
            {asArray(exitTicket.questions).map((item, index) => (
              <li key={index}>· {item}</li>
            ))}
          </ul>
          {exitTicket.success_criteria && (
            <p className="mt-1 text-xs text-muted-foreground">
              达成标准：{exitTicket.success_criteria}
            </p>
          )}
        </Section>
      </div>
    </div>
  )
}
