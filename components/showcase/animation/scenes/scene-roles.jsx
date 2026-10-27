import { interpolate, useCurrentFrame } from "remotion"
import { SHOWCASE_ROLES } from "@/lib/showcase-roles"
import { toneVideo } from "@/lib/showcase-palette"
import { Connector } from "../connectors"
import {
  Chip,
  EnterCard,
  Icon,
  loopT,
  NodeCard,
  SceneShell,
  STAGE,
} from "../primitives"

const SLOTS = {
  system_admin: { left: 260, top: 0, width: 300 },
  school_admin: { left: 20, top: 130, width: 300 },
  city_expert: { left: 500, top: 130, width: 300 },
  group_leader: { left: 20, top: 270, width: 300 },
  teacher: { left: 20, top: 410, width: 300 },
  student: { left: 20, top: 550, width: 300 },
}

function progressAt(frame, start) {
  return interpolate(frame, [start, start + 28], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
}

export function SceneRoles({ duration }) {
  const frame = useCurrentFrame()
  const activeIndex = Math.min(SHOWCASE_ROLES.length - 1, Math.floor(frame / 70))
  const activeRole = SHOWCASE_ROLES[activeIndex]
  const activeColor = toneVideo(activeRole.tone)
  const detailOpacity = interpolate(frame % 70, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  return (
    <SceneShell
      duration={duration}
      eyebrow="02 / 角色层级"
      title="人员层级：六类角色与职责"
      subtitle="系统管理员 → 学校管理员 / 市级专家 → 教研组长 → 教师 → 学生。"
      footer="任命边界：系统管理员不能任命教研组长；学校管理员不能任命市级专家；市级专家是岗位池，池内任一人处理。"
    >
      <div style={{ display: "flex", gap: 30, height: "100%", overflow: "hidden" }}>
        <div style={{ position: "relative", width: 820, height: "100%", flexShrink: 0 }}>
          <Connector x1={410} y1={80} x2={170} y2={130} color={toneVideo("violet")} progress={progressAt(frame, 16)} dotT={loopT(frame, 16, 55)} />
          <Connector x1={410} y1={80} x2={650} y2={130} color={toneVideo("violet")} progress={progressAt(frame, 24)} dotT={loopT(frame, 24, 55)} />
          <Connector x1={170} y1={210} x2={170} y2={270} color={toneVideo("violet")} progress={progressAt(frame, 32)} dotT={loopT(frame, 32, 55)} />
          <Connector x1={170} y1={410} x2={170} y2={350} color={toneVideo("amber")} progress={progressAt(frame, 40)} dotT={loopT(frame, 40, 55)} />
          <Connector x1={170} y1={270} x2={650} y2={210} color={toneVideo("amber")} progress={progressAt(frame, 48)} dotT={loopT(frame, 48, 55)} />
          <Connector x1={170} y1={490} x2={170} y2={550} color={toneVideo("sky")} progress={progressAt(frame, 56)} dotT={loopT(frame, 56, 55)} />

          {SHOWCASE_ROLES.map((role, index) => {
            const slot = SLOTS[role.id]
            if (!slot) return null
            return (
              <EnterCard
                key={role.id}
                delay={8 + index * 8}
                style={{ position: "absolute", left: slot.left, top: slot.top, width: slot.width, zIndex: 2 }}
              >
                <NodeCard
                  icon={role.icon}
                  title={role.title}
                  subtitle={role.scope}
                  tone={role.tone}
                  active={index === activeIndex}
                />
              </EnterCard>
            )
          })}
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 0,
            position: "relative",
            borderRadius: 20,
            border: `1px solid ${STAGE.cardBorder}`,
            background: STAGE.card,
            padding: 30,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              right: -30,
              bottom: -40,
              opacity: 0.07,
            }}
          >
            <Icon name={activeRole.icon} size={280} color={activeColor} />
          </div>

          <div style={{ opacity: detailOpacity, display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ fontSize: 16, letterSpacing: 4, color: STAGE.muted, fontWeight: 600 }}>
              {`角色详情 0${activeIndex + 1} / 06`}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18 }}>
              <span
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 18,
                  background: `${activeColor}14`,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Icon name={activeRole.icon} size={32} color={activeColor} />
              </span>
              <div>
                <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1 }}>{activeRole.title}</div>
                <div style={{ fontSize: 19, color: STAGE.muted, marginTop: 4 }}>{activeRole.scope}</div>
              </div>
            </div>

            <div style={{ marginTop: 26, fontSize: 23, lineHeight: 1.5 }}>{activeRole.duties}</div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 22 }}>
              {activeRole.appoints ? <Chip tone={activeRole.tone}>{activeRole.appoints}</Chip> : null}
              {activeRole.limit ? <Chip tone="slate">{activeRole.limit}</Chip> : null}
            </div>

            <div style={{ marginTop: "auto", display: "flex", gap: 8 }}>
              {SHOWCASE_ROLES.map((role, index) => (
                <span
                  key={role.id}
                  style={{
                    width: 42,
                    height: 6,
                    borderRadius: 999,
                    background: index === activeIndex ? activeColor : STAGE.line,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </SceneShell>
  )
}
