"use client"

// 错因诊断的渲染夹具：不连库、不调模型，只验证诊断卡片。
// 页面在 app/dev-error-diagnosis/page.jsx；生产环境 404。
import { ErrorDiagnosisPanel } from "@/components/classes/error-diagnosis-panel"

const QUESTIONS = [
  {
    seq: 1,
    qtype: "single_choice",
    difficulty: 2,
    node: "判别式",
    stem: "已知 x²-3x+2=0，判别式的值为（ ）",
    sample: 30,
    correct_rate: 0.3333,
    options: [
      { key: "A", text: "1", is_answer: true, count: 10 },
      { key: "B", text: "-1", is_answer: false, count: 20 },
    ],
    fill_texts: [],
    samples: [],
  },
  {
    seq: 2,
    qtype: "fill_blank",
    difficulty: 1,
    node: "一元二次方程",
    stem: "方程 x²-3x+2=0 的较小根是 ______",
    sample: 20,
    correct_rate: 0.25,
    options: [],
    fill_texts: [{ text: "-1", count: 15 }],
    samples: [],
  },
]

const DIAGNOSIS = {
  questions: [
    {
      seq: 1,
      sample: 30,
      causes: [
        {
          code: "concept_confusion",
          share: 0.6,
          evidence: "-1",
          remedy: "用 Δ=b²-4ac 与根的公式对比，说明判别式不是根",
        },
        {
          code: "calculation",
          share: 0.4,
          evidence: "1",
          remedy: "把 b² 与 4ac 分开写，避免符号错",
        },
      ],
      teaching_move: "先讲 B 选项的典型错误，再做一道只改系数的变式",
      caveats: "样本 30 人，结论仅供参考",
    },
    {
      seq: 2,
      sample: 20,
      causes: [
        {
          code: "calculation",
          share: 1,
          evidence: "-1",
          remedy: "代入验算两个根，强调较小根是 1 还是 -1",
        },
      ],
      teaching_move: "让学生互相检查代入过程",
      caveats: "",
    },
  ],
  summary: "本卷主要失分集中在判别式与根的区分，以及代入验算。",
  caveats: "只依据选项/填空文本，不含学生姓名。",
}

export function ErrorDiagnosisFixture() {
  return (
    <ErrorDiagnosisPanel
      paperId="p1"
      classId="c1"
      initialQuestions={QUESTIONS}
      initialDiagnosis={DIAGNOSIS}
    />
  )
}
