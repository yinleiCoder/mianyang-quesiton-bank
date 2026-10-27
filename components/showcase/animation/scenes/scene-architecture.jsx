import { useCurrentFrame } from "remotion"
import { ARCH_LANES, ARCH_NODES } from "@/lib/showcase-architecture"
import { toneVideo } from "@/lib/showcase-palette"
import {
  Chip,
  ColumnLabel,
  EnterCard,
  loopT,
  NodeCard,
  SceneShell,
  STAGE,
} from "../primitives"

const RIBBON = [
  { label: "用户端", tone: "sky" },
  { label: "Cloudflare / Worker", tone: "amber" },
  { label: "Next.js / Flutter", tone: "violet" },
  { label: "Supabase / OSS", tone: "emerald" },
  { label: "Vercel / Actions / Sentry", tone: "slate" },
]

export function SceneArchitecture({ duration }) {
  const frame = useCurrentFrame()

  return (
    <SceneShell
      duration={duration}
      eyebrow="01 / 架构分层"
      title="软件架构：从端到数据与交付"
      subtitle="所有业务数据经 Cloudflare Worker 进入 Supabase；媒体与安装包走阿里云 OSS。"
      footer="端 → 边缘 → 应用 → 数据 → 交付：一条链路看懂谁在调用谁，以及哪些组件只负责构建与观测。"
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 22, flex: 1, minHeight: 0 }}>
          {ARCH_LANES.map((lane, laneIndex) => {
            const nodes = ARCH_NODES.filter((node) => node.lane === lane.id)
            return (
              <div key={lane.id} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <ColumnLabel color={toneVideo(lane.tone)}>
                  {`0${laneIndex + 1} · ${lane.title}`}
                </ColumnLabel>
                <div style={{ fontSize: 14, color: STAGE.muted, marginTop: 2, lineHeight: 1.3 }}>
                  {lane.subtitle}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
                  {nodes.map((node, index) => (
                    <EnterCard key={node.id} delay={8 + laneIndex * 7 + index * 5}>
                      <NodeCard
                        icon={node.icon}
                        title={node.title}
                        subtitle={node.subtitle}
                        tone={node.tone}
                        badges={node.badges?.slice(0, 2) ?? []}
                      />
                    </EnterCard>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", marginTop: 12 }}>
          {RIBBON.map((item, index) => (
            <div key={item.label} style={{ display: "flex", alignItems: "center", flex: index === RIBBON.length - 1 ? 0 : 1 }}>
              <Chip tone={item.tone} solid={index === 0}>{item.label}</Chip>
              {index < RIBBON.length - 1 ? (
                <div style={{ position: "relative", flex: 1, height: 2, background: STAGE.line, margin: "0 12px" }}>
                  <span
                    style={{
                      position: "absolute",
                      top: -4,
                      left: `${loopT(frame, 50 + index * 12, 55) * 100}%`,
                      width: 9,
                      height: 9,
                      borderRadius: 999,
                      background: toneVideo(RIBBON[index + 1].tone),
                    }}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </SceneShell>
  )
}
