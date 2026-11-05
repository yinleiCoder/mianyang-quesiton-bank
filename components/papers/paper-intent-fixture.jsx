"use client"

// 一句话组卷的渲染夹具：不连库、不调模型，只验证“我理解成了”卡片与套用动作。
// 页面在 app/dev-paper-intent/page.jsx；生产环境 404。
import { useState } from "react"
import { PaperIntentPanel } from "@/components/papers/paper-intent-panel"
import { intentToRows } from "@/lib/paper-intent-prompt"

const NODES = [
  {
    id: "n1",
    parent_id: null,
    scope: "common",
    kind: "discipline",
    name: "数学",
    sort_order: 0,
    is_frozen: false,
  },
]

const TAGS = [
  {
    id: "t1",
    name: "一元二次方程",
    parent_id: null,
    subject_node_id: "n1",
    sort_order: 0,
  },
  {
    id: "t2",
    name: "判别式",
    parent_id: "t1",
    subject_node_id: "n1",
    sort_order: 0,
  },
]

const PARSED = {
  intent: {
    node_id: "n1",
    target_score: 90,
    exclude_recent_days: 30,
    requested_tag_ids: ["t1", "t2"],
    sections: [
      {
        title: "单项选择题",
        qtype: "single_choice",
        count: 10,
        score_mode: "per_item",
        score_each: 3,
        difficulty_mix: { easy: 0.6, medium: 0.3, hard: 0.1 },
        max_per_tag: 3,
      },
      {
        title: "填空题",
        qtype: "fill_blank",
        count: 5,
        score_mode: "per_blank",
        score_each: 2,
        difficulty_mix: { easy: 0.3, medium: 0.5, hard: 0.2 },
        max_per_tag: null,
      },
    ],
    assumptions: ["按“期中范围”理解为第三章及之前"],
    clarify: "",
  },
  warnings: [],
  matchedTags: TAGS,
}

export function PaperIntentFixture() {
  const [applied, setApplied] = useState(null)

  return (
    <div className="space-y-4">
      <PaperIntentPanel
        courseNodeId="n1"
        courseNodeName="数学"
        nodes={NODES}
        tags={TAGS}
        initialParsed={PARSED}
        currentTarget={90}
        onApplyIntent={(intent, meta) =>
          setApplied({ intent, meta, rows: intentToRows(intent) })
        }
      />

      <div className="rounded-xl border p-4">
        <h2 className="text-sm font-medium">套用结果（假数据）</h2>
        {applied ? (
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted/40 p-3 text-xs">
            {JSON.stringify(applied, null, 2)}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            点上面的「套用到下面的表单」，这里会显示转换后的 planner rows。
          </p>
        )}
      </div>
    </div>
  )
}
