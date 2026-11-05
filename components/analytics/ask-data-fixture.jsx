"use client"

// 学情问数的渲染夹具：不连库、不调模型，只验证“意图结果 + 弱项条形图”。
// 页面在 app/dev-analytics-intent/page.jsx；生产环境 404。
import { AskData } from "@/components/analytics/ask-data"

const NODES = [
  { id: "n1", name: "判别式", parent_id: null, scope: "common", kind: "course" },
  { id: "n2", name: "函数", parent_id: null, scope: "common", kind: "course" },
  { id: "n3", name: "集合", parent_id: null, scope: "common", kind: "course" },
]

const RESULT = {
  intent: "weak_nodes",
  params: { class_id: "c1", days: 30 },
  chart: "bar",
  title: "班级弱项",
  summary:
    "最近 30 天，最弱的知识点是 判别式（正确率 25%）；其次是 函数（90%）。建议先补这几个点。",
  rows: [
    { node_id: "n1", name: "判别式", accuracy: 0.25, attempts: 20 },
    { node_id: "n2", name: "函数", accuracy: 0.9, attempts: 10 },
  ],
}

export function AskDataFixture() {
  return (
    <AskData
      classId="c1"
      className="计算机 1 班"
      nodes={NODES}
      initialResult={RESULT}
    />
  )
}

const PAPER_RESULT = {
  intent: "question_stats",
  params: { paper_id: "p1", scope: "class" },
  chart: "table",
  title: "试题正确率",
  summary:
    "共 40 人参考；正确率最低的是第 2 题（25%，20 份已判分）。",
  rows: [
    {
      seq: 2,
      qtype: "fill_blank",
      graded: 20,
      correct_rate: 0.25,
      top_wrong: null,
      top_texts: ["-1"],
    },
    {
      seq: 1,
      qtype: "single_choice",
      graded: 30,
      correct_rate: 0.4,
      top_wrong: "B. -1（18 人）",
      top_texts: [],
    },
  ],
}

export function AskPaperFixture() {
  return (
    <AskData
      paperId="p1"
      paperTitle="期中卷"
      scope="class"
      activeClassId="c1"
      isStaff
      initialResult={PAPER_RESULT}
    />
  )
}
