// 软件宣传动画：同一套 composition，用 platform 切换 网页 / Windows / Android 三条分镜。
// 内容写死，不接收用户输入、不执行外部代码；只读播放。
import { AbsoluteFill, Sequence } from "remotion"
import { PROMO_PLATFORMS } from "@/lib/showcase-promo"
import { SHOWCASE_FONT } from "@/lib/showcase-animation"
import { PromoIntro } from "./promo-intro"
import { PromoOutro } from "./promo-outro"
import { PROMO_STAGE, PromoBackground, PromoBrand, PromoProgress } from "./promo-primitives"
import { PromoScene } from "./promo-scene"

export function PromoVideo({ platform = "web" }) {
  const data = PROMO_PLATFORMS[platform] ?? PROMO_PLATFORMS.web
  return (
    <AbsoluteFill
      style={{
        backgroundColor: PROMO_STAGE.bg,
        color: PROMO_STAGE.fg,
        fontFamily: SHOWCASE_FONT,
        overflow: "hidden",
      }}
    >
      <PromoBackground />
      <PromoBrand label={data.id === "web" ? "教师端" : "学生端"} />

      <Sequence from={data.intro.from} durationInFrames={data.intro.duration} name="片头">
        <PromoIntro platform={data} duration={data.intro.duration} />
      </Sequence>

      {data.chapters.map((chapter, index) => (
        <Sequence
          key={chapter.id}
          from={chapter.from}
          durationInFrames={chapter.duration}
          name={chapter.label}
        >
          <PromoScene
            chapter={chapter}
            platform={data}
            index={index}
            total={data.chapters.length}
          />
        </Sequence>
      ))}

      <Sequence from={data.outro.from} durationInFrames={data.outro.duration} name="片尾">
        <PromoOutro platform={data} duration={data.outro.duration} />
      </Sequence>

      <PromoProgress platform={data} />
    </AbsoluteFill>
  )
}
