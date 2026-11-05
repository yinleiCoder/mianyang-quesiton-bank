// 渲染检查页（fixture）：审题预检面板。
//
// ⚠ **不要删掉它**（2026-10-08 用户要求：删任何东西之前先问）。
//   只渲染下面写死的假数据，不读数据库、不调模型，任何账号都能打开；
//   下次改审题面板的排版/标记时不用再造样本。
import { notFound } from "next/navigation"
import { QuestionAuditPanel } from "@/components/questions/question-audit-panel"

const text = (value) => [{ t: "text", text: value }]

// 故意做坏的一道题：答案键对、但选项重复、含“以上都不对”、正确项明显最长、缺解析。
const FLAWED = {
  stem: text("下列关于计算机病毒的说法，正确的是"),
  options: [
    { key: "A", label: text("病毒是一段具有破坏性的程序，会自我复制并影响系统运行") },
    { key: "B", label: text("病毒只能通过 U 盘传播") },
    { key: "C", label: text("以上都不对") },
    { key: "D", label: text("病毒是一段具有破坏性的程序，会自我复制并影响系统运行") },
  ],
  answer: { type: "choice", keys: ["A"] },
}

export default function DevQuestionAuditPage() {
  if (process.env.VERCEL_ENV === "production") notFound()

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">审题预检夹具</h1>
      <p className="text-sm text-muted-foreground">
        下面是一道故意做坏的题：选项重复、含“以上都不对”、正确项明显最长、缺解析，并带一条 0.86
        的相似题。规则检查应给出「建议退回」；AI 复审可选。
      </p>
      <QuestionAuditPanel
        content={FLAWED}
        qtype="single_choice"
        difficulty={2}
        tags={["计算机"]}
        hasNode
        similar={[{ similarity: 0.86, stem: "关于计算机病毒的正确说法是……" }]}
        mode="author"
      />
    </main>
  )
}
