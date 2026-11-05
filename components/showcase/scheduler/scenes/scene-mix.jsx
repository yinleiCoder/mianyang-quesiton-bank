import { interpolate, useCurrentFrame } from "remotion"
import { STAGE, SceneShell } from "@/components/showcase/primitives"
import { Takeaway, useReveal } from "@/components/showcase/scheduler/primitives"
import { SCHEDULER_CONSTANTS as C } from "@/lib/showcase-scheduler"
import { toneVideo } from "@/lib/showcase-palette"

const COUNTS = [
  { key: "new", label: "新题", count: 8, tone: "violet", pct: "40%", rule: "保底", note: "曝光最少优先" },
  { key: "due", label: "到期复习", count: 6, tone: "sky", pct: "30%", rule: "配额", note: "最可能忘的优先" },
  { key: "mastered", label: "已掌握", count: 2, tone: "amber", pct: "10%", rule: "上限", note: "少量回顾" },
  { key: "filler", label: "补位", count: 4, tone: "emerald", pct: "补满", rule: "按分数", note: "薄弱 / 信息量大" },
]

const TILES = COUNTS.flatMap((item) =>
  Array.from({ length: item.count }, (_, index) => ({
    kind: item.key,
    tone: item.tone,
    index,
  }))
)

export function SceneMix({ duration }) {
  const frame = useCurrentFrame()
  const reveal = useReveal(14, 24)

  return (
    <SceneShell
      duration={duration}
      eyebrow="拼成一次练习"
      title="一次 20 题的练习是怎么拼出来的"
      subtitle="三个数管住主结构，剩下的按分数补。注意：这是保底、配额与上限，不是固定比例。"
      footer="池子不够时自动降级，甚至给不满 20 题 —— 不会拿烂题凑数。当天练过的题不发。"
    >
      <div style={{ display: "flex", gap: 44, height: "100%" }}>
        <div style={{ width: 760 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 16 }}>
            <span style={{ fontSize: 44, fontWeight: 800 }}>20</span>
            <span style={{ fontSize: 20, color: STAGE.muted }}>题里，</span>
            <span style={{ fontSize: 20, color: toneVideo("violet"), fontWeight: 700 }}>
              8 新 · 6 到期 · 2 已掌握 · 4 补位
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(10, 1fr)",
              gap: 10,
              width: 760,
            }}
          >
            {TILES.map((tile, index) => {
              const show = interpolate(frame, [24 + index * 3, 42 + index * 3], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
              const color = toneVideo(tile.tone)
              return (
                <div
                  key={`${tile.kind}-${tile.index}`}
                  style={{
                    height: 58,
                    borderRadius: 10,
                    background: color,
                    opacity: 0.18 + show * 0.82,
                    transform: `scale(${0.7 + show * 0.3})`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: 14,
                    fontWeight: 700,
                  }}
                >
                  {show > 0.6 ? index + 1 : ""}
                </div>
              )
            })}
          </div>

          <div style={{ display: "flex", gap: 16, marginTop: 22, opacity: reveal }}>
            {COUNTS.map((item) => (
              <span
                key={item.key}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 16, color: STAGE.muted }}
              >
                <span style={{ width: 12, height: 12, borderRadius: 4, background: toneVideo(item.tone) }} />
                {item.label} {item.count}
              </span>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {COUNTS.slice(0, 3).map((item, index) => {
            const show = interpolate(frame, [70 + index * 20, 96 + index * 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
            const color = toneVideo(item.tone)
            return (
              <div
                key={item.key}
                style={{
                  opacity: show,
                  transform: `translateY(${(1 - show) * 14}px)`,
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  background: STAGE.card,
                  border: `1.5px solid ${STAGE.cardBorder}`,
                  borderLeft: `6px solid ${color}`,
                  borderRadius: 14,
                  padding: "16px 20px",
                }}
              >
                <div
                  style={{
                    fontSize: 34,
                    fontWeight: 800,
                    color,
                    width: 96,
                    textAlign: "right",
                    flexShrink: 0,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {item.pct}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>
                    {item.rule} · {item.label}
                  </div>
                  <div style={{ fontSize: 15, color: STAGE.muted, marginTop: 3 }}>{item.note}</div>
                </div>
              </div>
            )
          })}

          <div
            style={{
              opacity: interpolate(frame, [140, 168], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <Takeaway tone={toneVideo("violet")}>
              {Math.round(C.newFloor * 100)}% 是「至少」，{Math.round(C.dueQuota * 100)}% 是「最多」，{" "}
              {Math.round(C.masteredCap * 100)}% 是「封顶」
            </Takeaway>
            <div style={{ fontSize: 16, color: STAGE.muted, lineHeight: 1.5 }}>
              新题 3 天内刚发过会扣 0.10 分；已掌握的判定是{" "}
              <b>S ≥ {C.masteredStability} 天</b> 且 <b>掌握度 ≥ {C.masteredMastery}</b>。
            </div>
          </div>
        </div>
      </div>
    </SceneShell>
  )
}
