import { useCurrentFrame } from "remotion"
import { BUSINESS_LOOP } from "@/lib/showcase-animation"
import { toneVideo } from "@/lib/showcase-palette"
import {
  Chip,
  EnterCard,
  NodeCard,
  SceneShell,
  STAGE,
} from "../primitives"

const CENTER = { x: 864, y: 350 }
const RADIUS = 292
const CARD_W = 220

export function SceneBusiness({ duration }) {
  const frame = useCurrentFrame()
  const activeIndex = frame < 40 ? 0 : Math.floor((frame - 40) / 35) % BUSINESS_LOOP.length
  const dotAngle = -Math.PI / 2 + (frame / 110) * Math.PI * 2
  const dotX = CENTER.x + RADIUS * Math.cos(dotAngle)
  const dotY = CENTER.y + RADIUS * Math.sin(dotAngle)

  return (
    <SceneShell
      duration={duration}
      eyebrow="05 / 业务闭环"
      title="从出题到再练：一个闭环"
      subtitle="题库 → 组卷 → 考试 → 练习 → 讲评 → 再练；学情数据自动回流。"
      footer="班级报告、易错题、AI 诊断 → 针对性练习：每一次作答都让下一轮更准。"
    >
      <div style={{ position: "relative", height: "100%", overflow: "hidden" }}>
        <svg style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
          <circle
            cx={CENTER.x}
            cy={CENTER.y}
            r={RADIUS}
            fill="none"
            stroke={STAGE.line}
            strokeWidth={2}
            strokeDasharray="10 12"
            strokeDashoffset={-frame * 1.5}
            opacity={0.85}
          />
          <circle cx={dotX} cy={dotY} r={7} fill={toneVideo("violet")} />
        </svg>

        <div
          style={{
            position: "absolute",
            left: CENTER.x,
            top: CENTER.y,
            width: 380,
            transform: "translate(-50%, -50%)",
            borderRadius: 24,
            border: `1.5px solid ${STAGE.cardBorder}`,
            background: STAGE.card,
            padding: "24px 26px",
            textAlign: "center",
            boxShadow: "0 14px 40px rgba(23,23,23,0.08)",
          }}
        >
          <div style={{ fontSize: 28, fontWeight: 800 }}>全市共享 · 持续改进</div>
          <div style={{ fontSize: 16, color: STAGE.muted, marginTop: 10, lineHeight: 1.5 }}>
            出题 → 审批 → 组卷 → 考试 → 练习 → 讲评 → 再练
          </div>
          <div style={{ marginTop: 14 }}>
            <Chip tone="emerald">数据自动回流</Chip>
          </div>
        </div>

        {BUSINESS_LOOP.map((item, index) => {
          const angle = -Math.PI / 2 + (index * Math.PI * 2) / BUSINESS_LOOP.length
          const x = CENTER.x + RADIUS * Math.cos(angle)
          const y = CENTER.y + RADIUS * Math.sin(angle)
          return (
            <EnterCard
              key={item.id}
              delay={8 + index * 8}
              style={{
                position: "absolute",
                left: x,
                top: y,
                width: CARD_W,
                transform: "translate(-50%, -50%)",
                zIndex: 2,
              }}
            >
              <NodeCard
                compact
                icon={item.icon}
                title={item.label}
                subtitle={item.sub}
                tone={index === activeIndex ? "violet" : "slate"}
                active={index === activeIndex}
              />
            </EnterCard>
          )
        })}
      </div>
    </SceneShell>
  )
}
