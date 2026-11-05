"use client"

// 智能组卷方案预览：指标 + 每道题的入选信息 + 逐题换一题。
// 只读展示，真正的写入仍由编辑器 dispatch("applyPlan") 后走 save_paper_draft。
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DecisionCard } from "@/components/ai/decision-card"
import { qtypeShortLabel } from "@/lib/question-model"

const BAND = { 1: "易", 2: "中", 3: "难" }

export function PaperAiPlanPreview({ plan, busy, onSwap }) {
  if (!plan) return null
  const metrics = plan.metrics
  const itemCount = plan.sections.reduce((sum, section) => sum + section.items.length, 0)

  return (
    <div className="space-y-3">
      <DecisionCard
        title="组卷方案"
        method="贪心 + 模拟退火（本地）"
        decision={`${plan.sections.length} 个大题、共 ${itemCount} 题${
          plan.feasible ? "" : "（候选不足，方案不完整）"
        }`}
        inputs={[
          plan.spec?.target_score != null ? `目标分 ${plan.spec.target_score}` : "不约束总分",
          `排除近 ${plan.spec?.exclude_recent_days ?? 0} 天`,
          `候选 ${plan.candidates?.length ?? "—"} 道`,
        ]}
        factors={[
          {
            label: "总分 / 目标",
            value: `${metrics.total_score}${metrics.target_score ? ` / ${metrics.target_score}` : ""}`,
          },
          {
            label: "难度 易/中/难",
            value: `${metrics.difficulty_mix[1]} / ${metrics.difficulty_mix[2]} / ${metrics.difficulty_mix[3]}`,
          },
          {
            label: "标签覆盖",
            value: `${metrics.tag_coverage.covered}/${metrics.tag_coverage.requested || "—"}`,
          },
          { label: "90 天曝光均值", value: metrics.exposure_avg.toFixed(2) },
          { label: "相似度均值", value: metrics.similarity_avg.toFixed(2) },
          { label: "目标函数值", value: metrics.objective.toFixed(3) },
          { label: "硬约束违约", value: metrics.violations },
        ]}
        confidence={plan.feasible ? 0.9 : 0.4}
        caveats={
          plan.warnings?.length > 0
            ? plan.warnings
            : "方案只是草稿；保存前请逐题核对，最近用过的题已被降权"
        }
      />

      {plan.sections.map((section, sectionIndex) => (
        <div key={section.key ?? sectionIndex} className="rounded-lg border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-sm font-medium">
            <span>{section.title || `第 ${sectionIndex + 1} 大题`}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {section.items.length} 题 · 每题/空 {section.score_each} 分 · {section.score_mode}
            </span>
          </div>
          <ul className="divide-y">
            {section.items.map((item, itemIndex) => (
              <li key={item.question_id} className="flex items-start gap-2 px-3 py-2 text-sm">
                <span className="w-6 shrink-0 text-xs text-muted-foreground">{itemIndex + 1}.</span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2">{item.stem_text || item.question_id}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                    <Badge variant="secondary" className="font-normal">
                      {qtypeShortLabel(item.qtype)}
                    </Badge>
                    <Badge variant="outline" className="font-normal">
                      {BAND[item.effective_difficulty] ?? "中"}
                    </Badge>
                    <Badge variant="outline" className="font-normal">
                      {item.score} 分
                    </Badge>
                    <span className="text-muted-foreground">作答 {item.attempts} 次</span>
                    {item.uses_90d > 0 && (
                      <span className="text-amber-600">近 90 天用过 {item.uses_90d} 次</span>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onSwap?.(sectionIndex, itemIndex)}
                >
                  换一题
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
