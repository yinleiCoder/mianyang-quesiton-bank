import { EnterCard, STAGE, SceneShell, StageGrid } from "@/components/showcase/primitives"
import { Takeaway, useReveal } from "@/components/showcase/scheduler/primitives"
import { toneVideo } from "@/lib/showcase-palette"

const TROUBLES = [
  {
    tone: "rose",
    title: "反复刷已经会的",
    body: "随机就是均匀抽样：你会的题和不会的题被抽中的概率一样大。时间花在最不需要的地方。",
  },
  {
    tone: "amber",
    title: "该复习的时候没复习",
    body: "记忆在忘记之前复习最省力。随机不管「上次是什么时候答的」，于是有的题三年没见，有的昨天刚做过。",
  },
  {
    tone: "sky",
    title: "薄弱点永远抽不到",
    body: "全库几千道题，某个知识点只有几十道。随机抽 20 题，碰上它纯靠运气，补不上短板。",
  },
]

export function SceneWhy({ duration }) {
  const reveal = useReveal(10, 24)

  return (
    <SceneShell
      duration={duration}
      eyebrow="问题"
      title="如果只是随机抽"
      subtitle="随机只保证「公平」，不保证「有效」——它不知道你会什么、忘了什么。"
      footer="所以真正的问题不是「抽哪些题」，而是「你现在缺哪一类题」。"
    >
      <div style={{ position: "absolute", inset: 0 }}>
        <StageGrid />
      </div>
      <div
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 28,
          paddingTop: 12,
        }}
      >
        {TROUBLES.map((item, index) => (
          <EnterCard key={item.title} delay={20 + index * 26}>
            <div
              style={{
                background: STAGE.card,
                border: `1.5px solid ${STAGE.cardBorder}`,
                borderRadius: 18,
                padding: "26px 26px 24px",
                height: 300,
                boxShadow: "0 6px 20px rgba(23,23,23,0.05)",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: 6,
                  height: "100%",
                  background: toneVideo(item.tone),
                }}
              />
              <div
                style={{
                  fontSize: 54,
                  fontWeight: 800,
                  color: `${toneVideo(item.tone)}26`,
                  lineHeight: 1,
                }}
              >
                0{index + 1}
              </div>
              <div style={{ fontSize: 27, fontWeight: 700, marginTop: 6, color: STAGE.fg }}>
                {item.title}
              </div>
              <div style={{ fontSize: 19, color: STAGE.muted, marginTop: 12, lineHeight: 1.55 }}>
                {item.body}
              </div>
            </div>
          </EnterCard>
        ))}
      </div>
      <div style={{ position: "absolute", left: 0, bottom: 6, opacity: reveal }}>
        <Takeaway tone={toneVideo("violet")}>
          抽题应该回答：这道题现在对我有多大的用？
        </Takeaway>
      </div>
    </SceneShell>
  )
}
