import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { Chip, STAGE, SceneShell } from "@/components/showcase/primitives"
import { Takeaway } from "@/components/showcase/scheduler/primitives"
import { FSRS_LADDER, FSRS_WRONG_RESULT, SCHEDULER_CONSTANTS } from "@/lib/showcase-scheduler"
import { toneVideo } from "@/lib/showcase-palette"

const ROWS = FSRS_LADDER.slice(0, 5)
const MAX_INTERVAL = SCHEDULER_CONSTANTS.maxIntervalDays

function intervalLabel(index) {
  if (index === 0) return "首次答对"
  return `第 ${index} 次复习答对`
}

export function SceneFsrsUpdate({ duration }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const wrong = spring({ frame: frame - 210, fps, config: { damping: 200, mass: 0.6 } })

  return (
    <SceneShell
      duration={duration}
      eyebrow="状态更新"
      title="答对拉长，答错压缩"
      subtitle="每答一次都会改写这道题的稳定性；下次什么时候出现，是算出来的，不是排好的。"
      footer="公式（0125）：答对 S' = S·(1 + e^{w₉}(11−D)S^{−w₁₀}(e^{w₁₁(1−R)}−1))；答错取 min(S, …)，只会压短不会清零。"
    >
      <div style={{ display: "flex", gap: 44, height: "100%" }}>
        <div style={{ flex: 1.35, minWidth: 0 }}>
          <div style={{ fontSize: 19, color: STAGE.muted, letterSpacing: 2, fontWeight: 700 }}>
            一直答对时的间隔（天）
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 18 }}>
            {ROWS.map((row, index) => {
              const show = interpolate(frame, [8 + index * 22, 30 + index * 22], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
              const width = Math.max(0.015, row.interval / MAX_INTERVAL)
              const capped = row.interval >= MAX_INTERVAL
              return (
                <div
                  key={row.step}
                  style={{ opacity: show, display: "flex", alignItems: "center", gap: 16 }}
                >
                  <div style={{ width: 190, fontSize: 18, color: STAGE.muted, textAlign: "right" }}>
                    {intervalLabel(index)}
                  </div>
                  <div
                    style={{
                      flex: 1,
                      height: 40,
                      borderRadius: 10,
                      background: "#efefe9",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${width * show * 100}%`,
                        height: "100%",
                        borderRadius: 10,
                        background: capped
                          ? `repeating-linear-gradient(45deg, ${toneVideo("amber")}, ${toneVideo("amber")} 8px, #d97706 8px, #d97706 16px)`
                          : toneVideo("violet"),
                      }}
                    />
                  </div>
                  <div
                    style={{
                      width: 150,
                      fontSize: 22,
                      fontWeight: 700,
                      color: capped ? toneVideo("amber") : STAGE.fg,
                    }}
                  >
                    {row.interval} 天
                    {capped ? <span style={{ fontSize: 15, marginLeft: 6 }}>封顶</span> : null}
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ marginTop: 22, display: "flex", gap: 10 }}>
            <Chip tone="violet">越熟 → 间隔越长</Chip>
            <Chip tone="amber">最长 {MAX_INTERVAL} 天必再到期</Chip>
          </div>
        </div>

        <div
          style={{
            width: 470,
            opacity: wrong,
            transform: `translateY(${(1 - wrong) * 20}px)`,
            background: STAGE.card,
            border: `1.5px solid ${toneVideo("rose")}33`,
            borderRadius: 18,
            padding: "24px 26px",
            alignSelf: "flex-start",
          }}
        >
          <div style={{ fontSize: 19, letterSpacing: 2, fontWeight: 700, color: toneVideo("rose") }}>
            同样的状态，答错一次
          </div>
          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 14 }}>
            <Row label="答错前" value={FSRS_WRONG_RESULT.intervalBefore} tone={toneVideo("violet")} />
            <div style={{ fontSize: 30, color: STAGE.muted, lineHeight: 1 }}>↓</div>
            <Row label="答错后" value={FSRS_WRONG_RESULT.intervalAfter} tone={toneVideo("rose")} />
          </div>
          <div style={{ fontSize: 16, color: STAGE.muted, marginTop: 18, lineHeight: 1.55 }}>
            稳定性从 {FSRS_WRONG_RESULT.before.toFixed(0)} 天压到{" "}
            {FSRS_WRONG_RESULT.after.toFixed(1)} 天，难度从{" "}
            {FSRS_WRONG_RESULT.difficultyBefore.toFixed(1)} 升到{" "}
            {FSRS_WRONG_RESULT.difficultyAfter.toFixed(1)}。
            下一次很快就会再见到它 —— 但不会判死刑。
          </div>
          <div style={{ marginTop: 18 }}>
            <Takeaway tone={toneVideo("rose")}>答错不是清零，是「尽快再来一次」</Takeaway>
          </div>
        </div>
      </div>
    </SceneShell>
  )
}

function Row({ label, value, tone }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
      <span style={{ fontSize: 18, color: STAGE.muted }}>{label}</span>
      <span style={{ fontSize: 34, fontWeight: 800, color: tone }}>{value} 天</span>
    </div>
  )
}
