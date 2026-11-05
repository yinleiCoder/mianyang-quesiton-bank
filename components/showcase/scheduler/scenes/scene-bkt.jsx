import { interpolate, useCurrentFrame } from "remotion"
import { Chip, STAGE, SceneShell } from "@/components/showcase/primitives"
import { Formula, useReveal } from "@/components/showcase/scheduler/primitives"
import { SCHEDULER_CONSTANTS as C } from "@/lib/showcase-scheduler"
import { toneVideo } from "@/lib/showcase-palette"

const PARAMS = [
  {
    key: "p_G",
    name: "p_G 猜对率",
    value: "按题型",
    tone: "sky",
    note: "四选一 0.25 · 判断题 0.5 · 其他 0.05。没掌握也可能答对。",
  },
  {
    key: "p_S",
    name: "p_S 失误率",
    value: `${Math.round(C.bktSlip * 100)}%`,
    tone: "amber",
    note: "掌握了也可能答错。所以不会因为一次错就判「没掌握」。",
  },
  {
    key: "p_T",
    name: "p_T 学习转移",
    value: `${Math.round(C.bktTransition * 100)}%`,
    tone: "emerald",
    note: "两次作答之间人也在学，每次都会往「掌握」挪一点。",
  },
]

export function SceneBkt({ duration }) {
  const frame = useCurrentFrame()
  const reveal = useReveal(16, 28)
  const arrow = interpolate(frame, [34, 72], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const formulaIn = interpolate(frame, [86, 110], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  return (
    <SceneShell
      duration={duration}
      eyebrow="知识追踪"
      title="BKT：看不见的「会」与「不会」"
      subtitle="把每道题看成一项技能，只维护一个数：你已经掌握它的概率 p。每答一次就用贝叶斯公式更新它。"
      footer="BKT 回答「哪里薄弱」，FSRS 回答「什么时候该复习」——两者不互相替代。"
    >
      <div style={{ display: "flex", gap: 40, height: "100%" }}>
        <div
          style={{
            width: 760,
            position: "relative",
            background: STAGE.card,
            border: `1.5px solid ${STAGE.cardBorder}`,
            borderRadius: 18,
            overflow: "hidden",
          }}
        >
          <StateNode
            top={54}
            title="已掌握"
            sub={`会，但仍可能答错 —— 失误 p_S = ${Math.round(C.bktSlip * 100)}%`}
            tone={toneVideo("emerald")}
            opacity={reveal}
          />
          <StateNode
            top={356}
            title="未掌握"
            sub="不会，但仍可能蒙对 —— 猜对率 p_G 按题型算"
            tone={toneVideo("rose")}
            opacity={reveal}
          />

          <svg
            width={760}
            height={560}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            <defs>
              <marker id="bkt-arrow" markerWidth="12" markerHeight="12" refX={9} refY={4} orient="auto">
                <path d="M0,0 L0,8 L10,4 z" fill={toneVideo("emerald")} />
              </marker>
            </defs>
            <line
              x1={600}
              y1={372}
              x2={600}
              y2={372 - 220 * arrow}
              stroke={toneVideo("emerald")}
              strokeWidth={3}
              markerEnd={arrow > 0.95 ? "url(#bkt-arrow)" : undefined}
            />
            <text
              x={614}
              y={268}
              fontSize={18}
              fontWeight={700}
              fill={toneVideo("emerald")}
              opacity={arrow}
            >
              p_T = {Math.round(C.bktTransition * 100)}%
            </text>
            <text x={614} y={292} fontSize={14} fill={STAGE.muted} opacity={arrow}>
              两次作答之间学会了
            </text>
          </svg>

          <div style={{ position: "absolute", left: 26, bottom: 22, display: "flex", gap: 10 }}>
            <Chip tone="emerald">状态：会 / 不会（看不见）</Chip>
            <Chip tone="sky">观测：答对 / 答错（看得见）</Chip>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {PARAMS.map((param, index) => {
            const show = interpolate(frame, [40 + index * 14, 62 + index * 14], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
            const color = toneVideo(param.tone)
            return (
              <div
                key={param.key}
                style={{
                  opacity: show,
                  transform: `translateX(${(1 - show) * 14}px)`,
                  border: `1.5px solid ${STAGE.cardBorder}`,
                  borderLeft: `6px solid ${color}`,
                  background: STAGE.card,
                  borderRadius: 14,
                  padding: "14px 18px",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                  <span style={{ fontSize: 21, fontWeight: 700 }}>{param.name}</span>
                  <span style={{ fontSize: 19, color, fontWeight: 700 }}>{param.value}</span>
                </div>
                <div style={{ fontSize: 15, color: STAGE.muted, marginTop: 5, lineHeight: 1.45 }}>
                  {param.note}
                </div>
              </div>
            )
          })}
          <div style={{ opacity: formulaIn, marginTop: 2 }}>
            <Formula tone={toneVideo("sky")} note="答错时把 p 与 (1−p) 对调即可。">
              p′ = p·(1−p_S) / [p·(1−p_S) + (1−p)·p_G]
            </Formula>
          </div>
        </div>
      </div>
    </SceneShell>
  )
}

function StateNode({ top, title, sub, tone, opacity }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 40,
        top,
        width: 520,
        opacity,
        border: `2px solid ${tone}`,
        background: `${tone}0d`,
        borderRadius: 16,
        padding: "14px 20px",
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 800, color: tone }}>{title}</div>
      <div style={{ fontSize: 16, color: STAGE.muted, marginTop: 4 }}>{sub}</div>
    </div>
  )
}
