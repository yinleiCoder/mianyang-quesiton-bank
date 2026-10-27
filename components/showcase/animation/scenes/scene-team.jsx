import { interpolate, useCurrentFrame } from "remotion"
import { TEAM_FLOW, TEAM_NOTE } from "@/lib/showcase-team"
import { toneVideo } from "@/lib/showcase-palette"
import { Connector } from "../connectors"
import {
  Chip,
  EnterCard,
  Icon,
  loopT,
  SceneShell,
  STAGE,
} from "../primitives"

const CARD_W = 320
const CARD_GAP = 24
const CARD_Y = 80
const CARD_H = 420
const CARD_X = TEAM_FLOW.map((_, index) => 16 + index * (CARD_W + CARD_GAP))

function progressAt(frame, start) {
  return interpolate(frame, [start, start + 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
}

function StageCard({ stage }) {
  const color = toneVideo(stage.tone)
  return (
    <div
      style={{
        width: CARD_W,
        height: CARD_H,
        boxSizing: "border-box",
        borderRadius: 20,
        border: `1.5px solid ${color}33`,
        background: STAGE.card,
        padding: "22px 22px 20px",
        boxShadow: `0 14px 34px ${color}14, 0 0 0 1px rgba(23,23,23,0.02)`,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, letterSpacing: 4, color: STAGE.muted, fontWeight: 700 }}>
          {stage.stage}
        </span>
        <span
          style={{
            width: 42,
            height: 42,
            borderRadius: 13,
            background: `${color}14`,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={stage.icon} size={22} color={color} />
        </span>
      </div>

      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 14, lineHeight: 1.2 }}>
        {stage.title}
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, marginTop: 16 }}>
        {stage.owners.map((owner) => (
          <Chip key={owner} tone={stage.tone}>{owner}</Chip>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
        {stage.bullets.map((bullet) => (
          <div key={bullet} style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 16, lineHeight: 1.4 }}>
            <span style={{ width: 7, height: 7, marginTop: 8, borderRadius: 999, background: color, flexShrink: 0 }} />
            <span>{bullet}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SceneTeam({ duration }) {
  const frame = useCurrentFrame()

  return (
    <SceneShell
      duration={duration}
      eyebrow="04 / 项目团队"
      title="岗位分工：从需求到上线"
      subtitle="企业真实开发流程：原型设计 → 界面实现 → 功能开发 → 自动化测试 → CI/CD 发布。"
      footer={TEAM_NOTE}
    >
      <div style={{ position: "relative", height: "100%", overflow: "hidden" }}>
        {TEAM_FLOW.slice(0, -1).map((stage, index) => {
          const next = TEAM_FLOW[index + 1]
          const startX = CARD_X[index] + CARD_W
          const endX = CARD_X[index + 1]
          return (
            <Connector
              key={`connector-${stage.id}`}
              x1={startX}
              y1={CARD_Y + CARD_H / 2}
              x2={endX}
              y2={CARD_Y + CARD_H / 2}
              color={toneVideo(next.tone)}
              progress={progressAt(frame, 22 + index * 16)}
              dotT={loopT(frame, 22 + index * 16, 46)}
              width={3}
            />
          )
        })}

        {TEAM_FLOW.map((stage, index) => (
          <EnterCard
            key={stage.id}
            delay={8 + index * 9}
            style={{
              position: "absolute",
              left: CARD_X[index],
              top: CARD_Y,
              zIndex: 2,
            }}
          >
            <StageCard stage={stage} />
          </EnterCard>
        ))}

        <div
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            top: CARD_Y + CARD_H + 44,
            height: 64,
            borderRadius: 16,
            border: `1.5px dashed ${toneVideo("emerald")}55`,
            background: `${toneVideo("emerald")}0c`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: toneVideo("emerald"),
            fontSize: 20,
            fontWeight: 700,
          }}
        >
          <Icon name="published" size={22} color={toneVideo("emerald")} />
          交付上线：Windows / Android 安装包 → 阿里云 OSS → 网页下载页
        </div>
      </div>
    </SceneShell>
  )
}
