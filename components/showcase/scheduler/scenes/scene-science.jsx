import { STAGE, SceneShell, EnterCard } from "@/components/showcase/primitives"
import { Takeaway, useReveal } from "@/components/showcase/scheduler/primitives"
import { toneVideo } from "@/lib/showcase-palette"

const EVIDENCE = [
  {
    tone: "violet",
    title: "间隔重复效应",
    body: "在快要忘的时候复习，比集中刷同一批题记得更久。FSRS 的 S 就是「多久后会忘」的量化。",
  },
  {
    tone: "sky",
    title: "测试效应",
    body: "一次主动回忆比再读一遍更能加固记忆。所以是「练」，不是「看」。",
  },
  {
    tone: "emerald",
    title: "最近发展区",
    body: "正确率约 70% 的题最有练习价值：全对是浪费时间，全错是打击信心。",
  },
  {
    tone: "amber",
    title: "可复核",
    body: "每个数字都能在迁移里找到出处，并且能按历史作答回放新旧两种策略做对比。",
  },
]

const BOUNDARIES = [
  "不预测分数",
  "不因一次答错判死刑",
  "最长 180 天必再到期",
  "参数是官方默认值，未按本校数据拟合",
]

export function SceneScience({ duration }) {
  const reveal = useReveal(16, 28)

  return (
    <SceneShell
      duration={duration}
      eyebrow="依据与边界"
      title="为什么说它科学，以及它不是什么"
      subtitle="两套模型都不是本站发明的：FSRS 是开源的间隔重复调度器，BKT 是 1995 年提出的经典知识追踪模型。"
      footer="本站做的是把它们接到真实题库上，并把每一步写成可复核的 SQL —— 不是把「AI 推荐」当黑箱。"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20, height: "100%" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 20 }}>
          {EVIDENCE.map((item, index) => (
            <EnterCard key={item.title} delay={18 + index * 20}>
              <div
                style={{
                  background: STAGE.card,
                  border: `1.5px solid ${STAGE.cardBorder}`,
                  borderRadius: 16,
                  padding: "22px 22px 20px",
                  height: 250,
                  borderTop: `5px solid ${toneVideo(item.tone)}`,
                }}
              >
                <div style={{ fontSize: 22, fontWeight: 700 }}>{item.title}</div>
                <div style={{ fontSize: 17, color: STAGE.muted, marginTop: 12, lineHeight: 1.6 }}>
                  {item.body}
                </div>
              </div>
            </EnterCard>
          ))}
        </div>

        <div
          style={{
            opacity: reveal,
            border: `1.5px dashed ${STAGE.line}`,
            borderRadius: 16,
            padding: "20px 24px",
            background: "#ffffff80",
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 700, color: STAGE.muted, letterSpacing: 2 }}>
            它不是什么
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 12, flexWrap: "wrap" }}>
            {BOUNDARIES.map((item) => (
              <span
                key={item}
                style={{
                  borderRadius: 999,
                  background: "#f1f1ec",
                  color: STAGE.fg,
                  padding: "8px 16px",
                  fontSize: 17,
                }}
              >
                {item}
              </span>
            ))}
          </div>
        </div>

        <div style={{ opacity: reveal }}>
          <Takeaway tone={toneVideo("emerald")}>
            排期是建议不是作业：教师仍可手动组卷，学生也可以自己选题
          </Takeaway>
        </div>
      </div>
    </SceneShell>
  )
}
