import { interpolate, useCurrentFrame } from "remotion"
import { toneVideo } from "@/lib/showcase-palette"
import { Connector, CurveConnector } from "../connectors"
import {
  Chip,
  EnterCard,
  Icon,
  loopT,
  SceneShell,
  STAGE,
} from "../primitives"

const STEPS = [
  { id: "teacher", left: 40, icon: "teacher", title: "教师提交", subtitle: "题目 / 试卷版本", tone: "sky", status: "提交" },
  { id: "group", left: 490, icon: "group_leader", title: "教研组长审核", subtitle: "stage=group · 本校 + 节点子树", tone: "amber", status: "初审" },
  { id: "city", left: 940, icon: "city_expert", title: "市级专家审核", subtitle: "stage=city · 岗位池", tone: "emerald", status: "终审" },
  { id: "publish", left: 1390, icon: "published", title: "入库发布", subtitle: "旧版本 superseded · 全市可见", tone: "emerald", status: "发布" },
]

function progressAt(frame, start) {
  return interpolate(frame, [start, start + 28], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
}

function StepCard({ step, active }) {
  const color = toneVideo(step.tone)
  return (
    <div
      style={{
        width: 320,
        height: 150,
        boxSizing: "border-box",
        borderRadius: 18,
        border: `1.5px solid ${active ? color : STAGE.cardBorder}`,
        background: STAGE.card,
        padding: "20px 22px",
        boxShadow: active ? `0 12px 34px ${color}26` : "0 4px 14px rgba(23,23,23,0.05)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            background: `${color}14`,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={step.icon} size={22} color={color} />
        </span>
        <Chip tone={step.tone} solid={active}>{step.status}</Chip>
      </div>
      <div style={{ fontSize: 27, fontWeight: 800, marginTop: 12 }}>{step.title}</div>
      <div style={{ fontSize: 16, color: STAGE.muted, marginTop: 4 }}>{step.subtitle}</div>
    </div>
  )
}

export function SceneApproval({ duration }) {
  const frame = useCurrentFrame()
  const activeIndex = Math.min(3, Math.floor(Math.max(0, frame - 20) / 70))
  const amber = toneVideo("amber")
  const emerald = toneVideo("emerald")
  const rose = toneVideo("rose")
  const slate = toneVideo("slate")

  return (
    <SceneShell
      duration={duration}
      eyebrow="03 / 审批闭环"
      title="两级审批：组长初审 → 市级专家终审"
      subtitle="退回必须写意见；唯一组长本人提交时跳过 group；市级专家是岗位池。"
      footer="通过后旧版本置为 superseded，current_published_version_id 切换；退回可改后重提。"
    >
      <div style={{ position: "relative", height: "100%", overflow: "hidden" }}>
        <Connector x1={360} y1={295} x2={490} y2={295} color={amber} progress={progressAt(frame, 28)} dotT={loopT(frame, 28, 50)} />
        <Connector x1={810} y1={295} x2={940} y2={295} color={amber} progress={progressAt(frame, 88)} dotT={loopT(frame, 88, 50)} />
        <Connector x1={1260} y1={295} x2={1390} y2={295} color={emerald} progress={progressAt(frame, 148)} dotT={loopT(frame, 148, 50)} />

        <CurveConnector
          x1={1100} y1={370} cx={650} cy={610} x2={200} y2={370}
          color={rose} progress={progressAt(frame, 210)} dotT={loopT(frame, 210, 65)} dashed
        />
        <CurveConnector
          x1={200} y1={220} cx={650} cy={38} x2={1100} y2={220}
          color={slate} progress={progressAt(frame, 118)} dotT={loopT(frame, 118, 65)} dashed
        />

        <div style={{ position: "absolute", left: 400, top: 322, fontSize: 15, color: amber, fontWeight: 600 }}>
          stage=group
        </div>
        <div style={{ position: "absolute", left: 850, top: 322, fontSize: 15, color: amber, fontWeight: 600 }}>
          stage=city
        </div>
        <div style={{ position: "absolute", left: 420, top: 630, fontSize: 16, color: rose, fontWeight: 600 }}>
          退回：必须写意见
        </div>
        <div style={{ position: "absolute", left: 430, top: 20, fontSize: 16, color: slate, fontWeight: 600 }}>
          唯一组长本人提交时跳过 group
        </div>

        {STEPS.map((step, index) => (
          <EnterCard
            key={step.id}
            delay={8 + index * 14}
            style={{ position: "absolute", left: step.left, top: 220, zIndex: 2 }}
          >
            <StepCard step={step} active={index === activeIndex} />
          </EnterCard>
        ))}
      </div>
    </SceneShell>
  )
}
