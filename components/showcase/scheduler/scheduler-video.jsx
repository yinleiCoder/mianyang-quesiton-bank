// 科学抽题算法动画的组合：内容在构建期写死，浏览器内用 @remotion/player 播放。
// 与「软件架构及人员管理动画」同范式：不接收用户输入、不执行外部代码，
// 不引入 @remotion/bundler / @remotion/renderer。
import { AbsoluteFill, Sequence } from "remotion"
import { SCHEDULER_FONT, SCHEDULER_SCENES } from "@/lib/showcase-scheduler"
import { StageGrid } from "@/components/showcase/primitives"
import { SceneIntro } from "./scenes/scene-intro"
import { SceneWhy } from "./scenes/scene-why"
import { SceneFsrs } from "./scenes/scene-fsrs"
import { SceneCurve } from "./scenes/scene-curve"
import { SceneFsrsUpdate } from "./scenes/scene-fsrs-update"
import { SceneBkt } from "./scenes/scene-bkt"
import { SceneBktUpdate } from "./scenes/scene-bkt-update"
import { SceneScore } from "./scenes/scene-score"
import { SceneMix } from "./scenes/scene-mix"
import { SceneScience } from "./scenes/scene-science"
import { SceneOutro } from "./scenes/scene-outro"

const COMPONENTS = {
  intro: SceneIntro,
  why: SceneWhy,
  fsrs: SceneFsrs,
  curve: SceneCurve,
  fsrsUpdate: SceneFsrsUpdate,
  bkt: SceneBkt,
  bktUpdate: SceneBktUpdate,
  score: SceneScore,
  mix: SceneMix,
  science: SceneScience,
  outro: SceneOutro,
}

// 分镜表与组件表分处两个文件，加一章却忘了写组件时，
// 这里在模块加载期就炸出来 —— 否则画面会安静地空一段。
const missing = SCHEDULER_SCENES.filter((scene) => !COMPONENTS[scene.id]).map((s) => s.id)
if (missing.length > 0) {
  throw new Error(`科学抽题动画缺少分镜组件：${missing.join("、")}`)
}

export function SchedulerVideo() {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#f6f6f4",
        color: "#171717",
        fontFamily: SCHEDULER_FONT,
        overflow: "hidden",
      }}
    >
      <StageGrid />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 50% 38%, transparent 36%, rgba(23,23,23,0.045) 100%)",
          pointerEvents: "none",
        }}
      />
      {SCHEDULER_SCENES.map((scene) => {
        const Scene = COMPONENTS[scene.id]
        return (
          <Sequence
            key={scene.id}
            from={scene.from}
            durationInFrames={scene.duration}
            name={scene.label}
          >
            <Scene duration={scene.duration} />
          </Sequence>
        )
      })}
    </AbsoluteFill>
  )
}
