import { interpolate, useCurrentFrame } from "remotion"
import { STAGE, SceneShell } from "@/components/showcase/primitives"
import {
  CurveChart,
  Dot,
  Meter,
  Takeaway,
  chartScale,
  useReveal,
} from "@/components/showcase/scheduler/primitives"
import { BKT_BRANCHES, BKT_INFO_CURVE, BKT_INFO_PEAK } from "@/lib/showcase-scheduler"
import { toneVideo } from "@/lib/showcase-palette"

const CHART_W = 620
const CHART_H = 340
const CHART_DOMAIN = { xMax: 1, yMax: 0.3 }
const DOT_P = (() => {
  const last = BKT_INFO_CURVE[BKT_INFO_CURVE.length - 1]
  return last.p
})()

// 在一次作答上做两次"如果"：答对会到哪、答错会到哪。
const BRANCHES = [
  {
    key: "correct",
    label: "答对",
    to: BKT_BRANCHES.correct,
    tone: "emerald",
    note: "涨得不多，因为可能是蒙对的。",
  },
  {
    key: "wrong",
    label: "答错",
    to: BKT_BRANCHES.wrong,
    tone: "rose",
    note: "掉得比涨得快，但不会掉到 0。",
  },
]

export function SceneBktUpdate({ duration }) {
  const frame = useCurrentFrame()
  const reveal = useReveal(10, 26)
  const correctP = interpolate(frame, [30, 80], [BKT_BRANCHES.start, BKT_BRANCHES.correct], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const wrongP = interpolate(frame, [96, 146], [BKT_BRANCHES.start, BKT_BRANCHES.wrong], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const dotT = interpolate(frame, [170, 250], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const dotP = 0.03 + dotT * (DOT_P - 0.03)
  const dotGain = interpolateGain(BKT_INFO_CURVE, dotP)

  return (
    <SceneShell
      duration={duration}
      eyebrow="一次作答"
      title="答一次，掌握度就更新一次"
      subtitle="0.50 表示「一半把握」。同一个起点，答对与答错走向完全不同的两条路。"
      footer="越接近 50% 的题，答一次越能区分你会不会 —— 这就是信息增益，选题时优先发它。"
    >
      <div style={{ display: "flex", gap: 40, height: "100%" }}>
        <div style={{ width: 660, display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              background: STAGE.card,
              border: `1.5px solid ${STAGE.cardBorder}`,
              borderRadius: 16,
              padding: "18px 22px",
              opacity: reveal,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontSize: 19, color: STAGE.muted }}>作答前掌握度</span>
              <span style={{ fontSize: 34, fontWeight: 800 }}>
                {(BKT_BRANCHES.start * 100).toFixed(0)}%
              </span>
            </div>
            <div style={{ marginTop: 10 }}>
              <Meter value={BKT_BRANCHES.start} tone={STAGE.muted} width={590} height={14} />
            </div>
          </div>

          {BRANCHES.map((branch, index) => {
            const value = branch.key === "correct" ? correctP : wrongP
            const show = interpolate(
              frame,
              [26 + index * 66, 40 + index * 66],
              [0, 1],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
            )
            const color = toneVideo(branch.tone)
            return (
              <div
                key={branch.key}
                style={{
                  opacity: show,
                  background: STAGE.card,
                  border: `1.5px solid ${color}33`,
                  borderLeft: `6px solid ${color}`,
                  borderRadius: 16,
                  padding: "16px 22px",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
                  <span style={{ fontSize: 22, fontWeight: 700, color }}>{branch.label}</span>
                  <span style={{ fontSize: 30, fontWeight: 800 }}>
                    {(value * 100).toFixed(1)}%
                  </span>
                  <span style={{ fontSize: 15, color: STAGE.muted, marginLeft: "auto" }}>
                    {branch.note}
                  </span>
                </div>
                <div style={{ marginTop: 10 }}>
                  <Meter value={value} tone={color} width={590} height={14} />
                </div>
              </div>
            )
          })}

          <div style={{ opacity: interpolate(frame, [150, 176], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}}>
            <Takeaway tone={toneVideo("emerald")}>
              连错四次只会收敛到 17%，不会归零；连对三次到 99.8%
            </Takeaway>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: STAGE.card,
            border: `1.5px solid ${STAGE.cardBorder}`,
            borderRadius: 18,
            padding: "16px 18px",
          }}
        >
          <div style={{ fontSize: 17, color: STAGE.muted, fontWeight: 700, letterSpacing: 1 }}>
            信息增益：答一次能问出多少信息
          </div>
          <CurveChart
            curves={[
              {
                key: "ig",
                color: toneVideo("sky"),
                points: BKT_INFO_CURVE.map((point) => ({ x: point.p, y: point.gain })),
              },
            ]}
            domain={CHART_DOMAIN}
            width={CHART_W + 40}
            height={CHART_H + 60}
            reveal={reveal}
            yFormat={(tick) => tick.toFixed(2)}
            xLabel="掌握度 p"
            yLabel="信息增益（nat）"
          >
            <Dot
              x={chartScale(CHART_DOMAIN, CHART_W + 40, CHART_H + 60).sx(dotP)}
              y={chartScale(CHART_DOMAIN, CHART_W + 40, CHART_H + 60).sy(dotGain)}
              color={toneVideo("rose")}
              r={7}
              label={`p = ${(dotP * 100).toFixed(0)}%`}
              labelDy={-14}
            />
          </CurveChart>
          <div style={{ fontSize: 14, color: STAGE.muted, marginTop: 4 }}>
            峰值出现在 p ≈ {(BKT_INFO_PEAK.p * 100).toFixed(0)}%（约{" "}
            {BKT_INFO_PEAK.gain.toFixed(3)} nat）；p 太接近 0 或 1 时，答一次几乎问不出新信息。
          </div>
        </div>
      </div>
    </SceneShell>
  )
}

function interpolateGain(points, p) {
  let best = points[0]
  for (const point of points) {
    if (Math.abs(point.p - p) < Math.abs(best.p - p)) best = point
  }
  return best.gain
}
