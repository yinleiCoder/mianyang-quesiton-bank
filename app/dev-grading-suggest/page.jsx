// 渲染检查页（fixture）：阅卷台的主观题 AI 建议。
//
// ⚠ **不要删掉它**（2026-10-08 用户要求：删任何东西之前先问）。
//   只渲染写死的题目/作答/建议，不读数据库、不调模型；任何账号都能打开。
import { notFound } from "next/navigation"
import { AiGradeSuggest } from "@/components/papers/ai-grade-suggest"

const text = (value) => [{ t: "text", text: value }]

const ITEM = {
  id: "item-1",
  seq: 8,
  qtype: "short_answer",
  score: 10,
  score_units: [4, 3, 3],
  content: {
    stem: text("简述计算机病毒的定义，并写出它的两个主要特征。"),
    answer: {
      type: "text",
      samples: ["病毒是一段具有破坏性的程序；具有传染性和潜伏性。"],
    },
    analysis: text("答出定义、传染性、潜伏性三个要点即可。"),
  },
}

const RECORD = {
  attempt_id: "attempt-1",
  grading: "pending",
  answer: { type: "text", text: "病毒是一段程序，会传染。" },
  units: [],
  comment: "",
}

const SUGGESTION = {
  units: [
    { index: 0, score: 3, max: 4, reason: "定义基本正确，但少了“破坏性”", evidence: "病毒是一段程序" },
    { index: 1, score: 3, max: 3, reason: "传染性已答出", evidence: "会传染" },
    { index: 2, score: 0, max: 3, reason: "未提潜伏性", evidence: "" },
  ],
  confidence: 0.72,
  comment: "定义基本正确，补上“破坏性”和“潜伏性”。",
  missing_points: ["破坏性", "潜伏性"],
  caveats: "只依据文本作答判断，未考虑字迹。",
}

export default function DevGradingSuggestPage() {
  if (process.env.VERCEL_ENV === "production") notFound()

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">AI 评分建议夹具</h1>
      <p className="text-sm text-muted-foreground">
        下面是一道待阅卷的主观题与一份假的 AI 建议（3 个评分点）。点「采纳建议」只会填输入框，
        真正保存仍由教师点「保存本题给分」。
      </p>
      <div className="rounded-xl border p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">第 8 题</span>
          <span className="text-muted-foreground">主观题 · 10 分 · 3 个评分点</span>
        </div>
        <p className="text-sm">简述计算机病毒的定义，并写出它的两个主要特征。</p>
        <div className="mt-2 rounded-lg border bg-card p-2 text-sm">
          考生作答：病毒是一段程序，会传染。
        </div>
        <AiGradeSuggest
          item={ITEM}
          record={RECORD}
          labels={["定义", "传染性", "潜伏性"]}
          initialSuggestion={SUGGESTION}
        />
      </div>
    </main>
  )
}
