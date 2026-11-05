import { interpolate, useCurrentFrame } from "remotion"
import { STAGE, SceneShell } from "@/components/showcase/primitives"
import { Formula, useReveal } from "@/components/showcase/scheduler/primitives"
import { REASON_LABELS, SCORE_SUSPECTS } from "@/lib/showcase-scheduler"
import { toneVideo } from "@/lib/showcase-palette"

const PARTS = [
  { key: "r", label: "该忘了 (1−R)", tone: "violet" },
  { key: "need", label: "没掌握", tone: "rose" },
  { key: "zpd", label: "够得着", tone: "sky" },
  { key: "info", label: "信息量", tone: "emerald" },
  { key: "coverage", label: "没见过", tone: "amber" },
]

const MAX_TOTAL = Math.max(...SCORE_SUSPECTS.map((item) => item.parts.total))

export function SceneScore({ duration }) {
  const frame = useCurrentFrame()
  const reveal = useReveal(16, 30)

  return (
    <SceneShell
      duration={duration}
      eyebrow="综合打分"
      title="剩下的名额按综合得分排"
      subtitle="四个候选、四种理由。分数不代表「哪道题更好」，只代表「对现在的你更有用」。"
      footer="新题不靠打分进坑位：它走 40% 保底，打分时用的是中性特征。"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%" }}>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", opacity: reveal }}>
          {PARTS.map((part) => (
            <span
              key={part.key}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 15, color: STAGE.muted }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 4,
                  background: toneVideo(part.tone),
                }}
              />
              {part.label}
            </span>
          ))}
        </div>

        <div
          style={{
            background: STAGE.card,
            border: `1.5px solid ${STAGE.cardBorder}`,
            borderRadius: 18,
            padding: "24px 28px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {SCORE_SUSPECTS.map((item, index) => {
            const show = interpolate(frame, [30 + index * 24, 58 + index * 24], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
            return (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 16, opacity: show }}>
                <div style={{ width: 210 }}>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{item.label}</div>
                  <div style={{ fontSize: 14, color: STAGE.muted, marginTop: 3, lineHeight: 1.35 }}>
                    {REASON_LABELS[item.reason]}
                  </div>
                </div>

                <div
                  style={{
                    flex: 1,
                    height: 34,
                    borderRadius: 8,
                    background: "#efefe9",
                    overflow: "hidden",
                    display: "flex",
                  }}
                >
                  {PARTS.map((part) => (
                    <div
                      key={part.key}
                      style={{
                        width: `${((item.parts[part.key] * show) / (MAX_TOTAL * 1.12)) * 100}%`,
                        height: "100%",
                        background: toneVideo(part.tone),
                      }}
                    />
                  ))}
                </div>

                <div
                  style={{
                    width: 88,
                    textAlign: "right",
                    fontSize: 24,
                    fontWeight: 800,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {item.parts.total.toFixed(3)}
                </div>
              </div>
            )
          })}
        </div>

        <div style={{ opacity: interpolate(frame, [140, 170], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })}}>
          <Formula note="balanced 模式的五项权重与加减分；weak / review / challenge 模式各有一套权重。">
            0.38·(1−R) + 0.22·没掌握 + 0.14·够得着 + 0.10·信息量 + 0.10·没见过
          </Formula>
        </div>
      </div>
    </SceneShell>
  )
}
