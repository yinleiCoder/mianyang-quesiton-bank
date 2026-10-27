// 展示页的语义色：React Flow 用 CSS 变量（跟随深浅色），Remotion 用固定 hex。
// 纯数据模块：不要 import React / lucide / Remotion / @xyflow/react。
export const SHOWCASE_TONES = {
  sky: { cssVar: "--showcase-sky", video: "#0369a1", label: "端 / 访问" },
  violet: { cssVar: "--showcase-violet", video: "#6d28d9", label: "应用 / 任命" },
  emerald: { cssVar: "--showcase-emerald", video: "#047857", label: "数据 / 发布" },
  amber: { cssVar: "--showcase-amber", video: "#b45309", label: "边缘 / 审批" },
  rose: { cssVar: "--showcase-rose", video: "#be123c", label: "观测 / AI" },
  slate: { cssVar: "--showcase-slate", video: "#475569", label: "构建 / 辅助" },
}

export function toneOf(tone) {
  return SHOWCASE_TONES[tone] ?? SHOWCASE_TONES.slate
}

export function toneCss(tone) {
  return `var(${toneOf(tone).cssVar})`
}

export function toneVideo(tone) {
  return toneOf(tone).video
}
