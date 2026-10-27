import { useCurrentFrame } from "remotion"
import { SHOWCASE_TEAM, TEAM_PIPELINE } from "@/lib/showcase-team"
import { toneVideo } from "@/lib/showcase-palette"
import {
  Chip,
  EnterCard,
  Icon,
  SceneShell,
  STAGE,
} from "../primitives"

const SLOTS = [
  { left: 64, top: 10 },
  { left: 614, top: 10 },
  { left: 1164, top: 10 },
  { left: 64, top: 240 },
  { left: 614, top: 240 },
  { left: 1164, top: 240 },
]

function TeamCard({ member }) {
  const color = toneVideo(member.tone)
  return (
    <div
      style={{
        width: 500,
        height: 190,
        boxSizing: "border-box",
        borderRadius: 18,
        border: `1.5px solid ${STAGE.cardBorder}`,
        background: STAGE.card,
        padding: "20px 24px",
        boxShadow: "0 4px 14px rgba(23,23,23,0.05)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: `${color}14`,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name={member.icon} size={23} color={color} />
          </span>
          <div style={{ fontSize: 26, fontWeight: 800 }}>{member.title}</div>
        </div>
        <Chip tone={member.tone}>{member.owner}</Chip>
      </div>
      <div style={{ fontSize: 18, lineHeight: 1.45, marginTop: 14, color: STAGE.fg }}>{member.duties}</div>
      {member.note ? (
        <div style={{ fontSize: 15, color: STAGE.muted, marginTop: 8 }}>{member.note}</div>
      ) : null}
    </div>
  )
}

export function SceneTeam({ duration }) {
  const frame = useCurrentFrame()
  const activePipeline = Math.min(
    TEAM_PIPELINE.length,
    Math.floor(Math.max(0, frame - 130) / 24)
  )

  return (
    <SceneShell
      duration={duration}
      eyebrow="04 / 项目团队"
      title="六个岗位，一条交付流水线"
      subtitle="项目经理协调需求、计划、验收；Flutter / 网站 / 测试 / CI-CD 各管一段。"
      footer="团队岗位不是系统角色，不参与题目/试卷审批；发布由 GitHub Actions 自动完成。"
    >
      <div style={{ position: "relative", height: "100%", overflow: "hidden" }}>
        {SHOWCASE_TEAM.map((member, index) => (
          <EnterCard
            key={member.id}
            delay={8 + index * 10}
            style={{ position: "absolute", left: SLOTS[index].left, top: SLOTS[index].top }}
          >
            <TeamCard member={member} />
          </EnterCard>
        ))}

        <div
          style={{
            position: "absolute",
            left: 64,
            right: 64,
            top: 500,
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 18, fontWeight: 700, color: STAGE.muted, marginRight: 6 }}>
            发布流水线
          </span>
          {TEAM_PIPELINE.map((step, index) => (
            <div key={step} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Chip tone={index < activePipeline ? "emerald" : "slate"} solid={index < activePipeline}>
                {step}
              </Chip>
              {index < TEAM_PIPELINE.length - 1 ? (
                <span style={{ color: STAGE.muted, fontSize: 20 }}>→</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </SceneShell>
  )
}
