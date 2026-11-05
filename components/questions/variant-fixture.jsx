"use client"

// AI 变式题的渲染夹具：不连库、不调模型，只验证“生成结果 + 规则问题 + 查重”卡片。
// 页面在 app/dev-variant/page.jsx；生产环境 404。
import { useState } from "react"
import { VariantDialog } from "@/components/questions/variant-dialog"
import { Button } from "@/components/ui/button"

const DRAFT = {
  qtype: "single_choice",
  difficulty: 2,
  nodeId: "n1",
  stem: [{ t: "text", text: "已知 x²-3x+2=0，判别式的值为（ ）" }],
  options: [
    { key: "A", label: [{ t: "text", text: "1" }] },
    { key: "B", label: [{ t: "text", text: "-1" }] },
    { key: "C", label: [{ t: "text", text: "5" }] },
    { key: "D", label: [{ t: "text", text: "-5" }] },
  ],
  answer: { type: "choice", keys: ["A"] },
  analysis: [{ t: "text", text: "Δ=b²-4ac=9-8=1。" }],
  tags: [{ id: "t1", name: "判别式" }],
}

const RESULTS = [
  {
    qtype: "single_choice",
    difficulty: 2,
    content: {
      format_version: 1,
      stem: [{ t: "text", text: "已知 x²-5x+6=0，判别式的值为（ ）" }],
      options: [
        { key: "A", label: [{ t: "text", text: "1" }] },
        { key: "B", label: [{ t: "text", text: "2" }] },
        { key: "C", label: [{ t: "text", text: "3" }] },
        { key: "D", label: [{ t: "text", text: "4" }] },
      ],
      answer: { type: "choice", keys: ["A"] },
      analysis: [{ t: "text", text: "Δ=25-24=1。" }],
    },
    issues: [
      {
        severity: "warn",
        category: "难度",
        problem: "标注难度与实测难度可能有偏差",
        suggestion: "入库后看真实作答再校准",
      },
    ],
    similar: [
      { similarity: 0.42, stem: "已知 x²-4x+3=0，判别式的值为（ ）" },
    ],
    note: "只改了系数，仍考查判别式",
  },
  {
    invalidReason: "题型不一致（填空题），本轮只生成同题型",
    note: "模型把题改成了填空题",
  },
]

export function VariantFixture() {
  const [open, setOpen] = useState(true)

  return (
    <div className="space-y-3">
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        打开变式题对话框
      </Button>
      <VariantDialog
        open={open}
        onOpenChange={setOpen}
        draft={DRAFT}
        nodes={[{ id: "n1", name: "数学", parent_id: null }]}
        initialResults={RESULTS}
        initialCaveats="生成题请核对答案与解析"
        initialWarnings={[]}
      />
    </div>
  )
}
