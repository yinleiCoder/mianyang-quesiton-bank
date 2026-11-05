import { useCurrentFrame, interpolate } from "remotion"
import { STAGE, SceneShell } from "@/components/showcase/primitives"
import { CurveChart, Formula, Legend, useReveal } from "@/components/showcase/scheduler/primitives"
import { FORGETTING_CURVES, FSRS_LADDER } from "@/lib/showcase-scheduler"
import { toneVideo } from "@/lib/showcase-palette"

const CURVE_COLORS = ["#6d28d9", "#0369a1", "#047857", "#b45309", "#475569"]

const DSR = [
  { key: "D", name: "难度", value: "1 – 10", tone: "rose", note: "这道题本身有多难，答错会往上走" },
  { key: "S", name: "稳定性", value: "天", tone: "violet", note: "记忆能撑多久不掉到 90% 以下" },
  { key: "R", name: "可提取性", value: "0 – 1", tone: "emerald", note: "此刻还记得的概率，随天数衰减" },
]

export function SceneFsrs({ duration }) {
  const frame = useCurrentFrame()
  const reveal = useReveal(45, 45)
  const initial = FSRS_LADDER[0]
  const sForCard = interpolate(frame, [20, 60], [0, initial.stability], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  return (
    <SceneShell
      duration={duration}
      eyebrow="记忆模型"
      title="FSRS-6：每道题都有一份记忆档案"
      subtitle="不是所有人共用一条复习阶梯，而是每道题、每个人都单独算一份状态。"
      footer="同一道题，稳定性越大曲线越平：S = 1 天时一天就掉到 90%，S = 90 天时要三个月才掉到 90%。"
    >
      <div style={{ display: "flex", gap: 40, height: "100%" }}>
        <div style={{ width: 560, display: "flex", flexDirection: "column", gap: 14 }}>
          {DSR.map((item, index) => {
            const show = interpolate(frame, [10 + index * 10, 30 + index * 10], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
            const color = toneVideo(item.tone)
            return (
              <div
                key={item.key}
                style={{
                  opacity: show,
                  transform: `translateX(${(1 - show) * -16}px)`,
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  background: STAGE.card,
                  border: `1.5px solid ${STAGE.cardBorder}`,
                  borderRadius: 16,
                  padding: "16px 20px",
                }}
              >
                <span
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: `${color}16`,
                    color,
                    fontWeight: 800,
                    fontSize: 24,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {item.key}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>
                    {item.name}
                    <span style={{ fontSize: 16, color: STAGE.muted, fontWeight: 500, marginLeft: 10 }}>
                      {item.key === "S" ? `初始 ${sForCard.toFixed(2)} 天` : item.value}
                    </span>
                  </div>
                  <div style={{ fontSize: 16, color: STAGE.muted, marginTop: 4, lineHeight: 1.4 }}>
                    {item.note}
                  </div>
                </div>
              </div>
            )
          })}
          <div style={{ opacity: reveal, marginTop: 4 }}>
            <Formula note="R 是时间 t 的函数；w₂₀ = 0.1542，F ≈ 0.9804。">
              R(t, S) = (1 + F · t / S) ^ (−w₂₀)
            </Formula>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              background: STAGE.card,
              border: `1.5px solid ${STAGE.cardBorder}`,
              borderRadius: 18,
              padding: 18,
            }}
          >
            <CurveChart
              curves={FORGETTING_CURVES.map((curve, index) => ({
                key: `s${curve.stability}`,
                color: CURVE_COLORS[index],
                points: curve.points.map((point) => ({ x: point.day, y: point.r })),
              }))}
              domain={{ xMax: 60, yMax: 1 }}
              width={900}
              height={430}
              reveal={reveal}
              xLabel="距上次作答的天数"
              yLabel="还记得的概率 R"
            />
          </div>
          <div style={{ opacity: reveal }}>
            <Legend
              items={FORGETTING_CURVES.map((curve, index) => ({
                label: `S = ${curve.stability} 天`,
                color: CURVE_COLORS[index],
              }))}
            />
          </div>
        </div>
      </div>
    </SceneShell>
  )
}
