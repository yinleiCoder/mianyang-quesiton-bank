"use client"

// 学习画像雷达图的渲染夹具：三套假数据（新同学 / 稳健型 / 冲刺型）。
// 页面在 app/dev-profile-radar/page.jsx；生产环境 404。
import { LearningProfileCard } from "@/components/students/learning-profile-card"

const LABELS = {
  mastery: "掌握力",
  accuracy: "准确率",
  effort: "勤奋度",
  growth: "进步力",
  breadth: "知识面",
  stability: "稳定性",
}

const HINTS = {
  mastery: "BKT 加权掌握度",
  accuracy: "客观题正确率",
  effort: "28 天活跃 20 天记满分",
  growth: "近 14 天相对前 14 天的正确率变化",
  breadth: "不同知识点（标签）数的指数饱和",
  stability: "每日正确率的波动",
}

const RAWS = {
  mastery: { mastery: 0.78, attempts: 120, window_days: 365 },
  accuracy: { correct: 81, attempts: 100, window_days: 90 },
  effort: { active_days_28: 17, goal_days: 20, window_days: 28 },
  growth: {
    recent_attempts: 40,
    recent_correct: 32,
    prev_attempts: 40,
    prev_correct: 30,
    window_days: 28,
  },
  breadth: { distinct_tags: 6, window_days: 90 },
  stability: { daily_accuracy_sd: 0.12, active_days: 12, window_days: 90 },
}

function profile(name, scores) {
  return {
    student: { user_id: "u1", name, class_name: "计算机 1 班", major_name: "计算机应用" },
    window_days: 90,
    axes: Object.entries(LABELS).map(([key, label]) => ({
      key,
      label,
      score: scores[key] ?? null,
      raw: RAWS[key],
      sample: RAWS[key].attempts ?? RAWS[key].distinct_tags ?? RAWS[key].active_days ?? 0,
      sufficient: (scores[key] ?? null) != null,
      hint: HINTS[key],
    })),
    caveats: ["画像只反映最近 90 天的练习数据，不代表能力全貌"],
    generated_at: "2026-11-03T12:00:00+08:00",
  }
}

const CASES = [
  {
    title: "稳健型（六轴齐全）",
    data: profile("张三", {
      mastery: 78,
      accuracy: 81,
      effort: 60,
      growth: 50,
      breadth: 50,
      stability: 74,
    }),
  },
  {
    title: "冲刺型（进步 + 勤奋）",
    data: profile("李四", {
      mastery: 50,
      accuracy: 60,
      effort: 80,
      growth: 65,
      breadth: 50,
      stability: 50,
    }),
  },
  {
    title: "新同学（数据不足，不画雷达）",
    data: profile("王五", {
      mastery: 80,
      accuracy: null,
      effort: null,
      growth: null,
      breadth: 40,
      stability: null,
    }),
  },
]

export function LearningProfileFixture() {
  return (
    <div className="space-y-4">
      {CASES.map((item) => (
        <div key={item.title} className="space-y-2">
          <h2 className="text-sm font-medium">{item.title}</h2>
          <LearningProfileCard profile={item.data} />
        </div>
      ))}
    </div>
  )
}
