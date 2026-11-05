import { STAGE, SceneShell } from "@/components/showcase/primitives"
import {
  CurveChart,
  Dot,
  Takeaway,
  chartScale,
  useReveal,
} from "@/components/showcase/scheduler/primitives"
import { FORGETTING_CURVES, RETENTION_MARKERS } from "@/lib/showcase-scheduler"
import { toneVideo } from "@/lib/showcase-palette"

const WIDTH = 1180
const HEIGHT = 520
const DOMAIN = { xMax: 30, yMax: 1 }
const CURVE_COLORS = { 1: "#6d28d9", 3: "#0369a1", 10: "#047857", 30: "#b45309" }
const HIGHLIGHT = 3

export function SceneCurve({ duration }) {
  const reveal = useReveal(20, 50)
  const { sx, sy } = chartScale(DOMAIN, WIDTH, HEIGHT)

  const curves = FORGETTING_CURVES.filter((curve) => DOMAIN.xMax >= curve.stability).map(
    (curve) => ({
      key: `s${curve.stability}`,
      color: CURVE_COLORS[curve.stability] ?? "#475569",
      width: curve.stability === HIGHLIGHT ? 5 : 2.5,
      opacity: curve.stability === HIGHLIGHT ? 1 : 0.45,
      points: curve.points
        .filter((point) => point.day <= DOMAIN.xMax)
        .map((point) => ({ x: point.day, y: point.r })),
    })
  )

  const markers = RETENTION_MARKERS.filter((marker) => marker.day <= DOMAIN.xMax)

  return (
    <SceneShell
      duration={duration}
      eyebrow="参照与目标"
      title="复习要卡在掉到 90% 之前"
      subtitle="遗忘先快后慢。经典实验里学完一天大约只剩三成，之后逐渐走平——但每个人的每道题并不一样。"
      footer="艾宾浩斯曲线只当参照线；真正决定「哪道题哪天到期」的是这道题自己的稳定性 S。"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%" }}>
        <div
          style={{
            background: STAGE.card,
            border: `1.5px solid ${STAGE.cardBorder}`,
            borderRadius: 18,
            padding: "16px 20px",
          }}
        >
          <CurveChart
            curves={curves}
            domain={DOMAIN}
            width={WIDTH}
            height={HEIGHT}
            reveal={reveal}
            padding={{ top: 30, right: 40, bottom: 48, left: 64 }}
            xLabel="距上次作答的天数"
            yLabel="还记得的概率 R"
          >
            {/* 90% 目标线 */}
            <line
              x1={sx(0)}
              x2={sx(DOMAIN.xMax)}
              y1={sy(0.9)}
              y2={sy(0.9)}
              stroke={toneVideo("rose")}
              strokeWidth={2}
              strokeDasharray="8 8"
              opacity={reveal}
            />
            <text
              x={sx(DOMAIN.xMax) - 6}
              y={sy(0.9) - 12}
              textAnchor="end"
              fontSize={16}
              fontWeight={700}
              fill={toneVideo("rose")}
              opacity={reveal}
            >
              目标保持率 90%
            </text>

            {/* 每条曲线与 90% 线的交点：横坐标恰好等于 S */}
            {markers.map((marker) => (
              <g key={`m${marker.stability}`} opacity={reveal}>
                <line
                  x1={sx(marker.day)}
                  x2={sx(marker.day)}
                  y1={sy(0.9)}
                  y2={sy(0)}
                  stroke={CURVE_COLORS[marker.stability]}
                  strokeWidth={1.5}
                  strokeDasharray="4 6"
                  opacity={0.55}
                />
                <Dot
                  x={sx(marker.day)}
                  y={sy(0.9)}
                  color={CURVE_COLORS[marker.stability]}
                  r={marker.stability === HIGHLIGHT ? 8 : 5}
                  label={marker.stability === HIGHLIGHT ? `S = ${marker.stability} 天` : undefined}
                  labelDy={marker.stability === HIGHLIGHT ? -18 : 0}
                />
              </g>
            ))}

            {/* 艾宾浩斯参考点：学完 1 天约剩 33% */}
            <g opacity={reveal}>
              <circle
                cx={sx(1)}
                cy={sy(0.33)}
                r={7}
                fill={STAGE.bg}
                stroke={STAGE.muted}
                strokeWidth={2.5}
                strokeDasharray="3 3"
              />
              <text
                x={sx(1) + 14}
                y={sy(0.33) - 12}
                fontSize={15}
                fill={STAGE.muted}
              >
                经典实验：1 天约剩 33%
              </text>
            </g>
          </CurveChart>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 18, opacity: reveal }}>
          <Takeaway tone={CURVE_COLORS[HIGHLIGHT]}>
            稳定性 S 天 = 保持率掉到 90% 的那一天；按 90% 排期，间隔就是 S 天
          </Takeaway>
          <span style={{ fontSize: 17, color: STAGE.muted }}>
            所以「什么时候复习」不用猜，算得出来。
          </span>
        </div>
      </div>
    </SceneShell>
  )
}
