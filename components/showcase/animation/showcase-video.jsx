// 只读展示动画：内容在构建期写死，浏览器内用 @remotion/player 播放。
// 不接收用户输入、不执行用户/AI 生成的代码，不复用 teaching_animations 表，
// 不引入 @remotion/bundler / @remotion/renderer / @babel/standalone / new Function。
// 这是与 2026-10-09 撤掉的「教师写动画」完全不同的功能。
import { AbsoluteFill, Sequence } from "remotion"
import { SCENES, SHOWCASE_FONT } from "@/lib/showcase-animation"
import { StageGrid } from "./primitives"
import { SceneApproval } from "./scenes/scene-approval"
import { SceneArchitecture } from "./scenes/scene-architecture"
import { SceneBusiness } from "./scenes/scene-business"
import { SceneIntro } from "./scenes/scene-intro"
import { SceneOutro } from "./scenes/scene-outro"
import { SceneRoles } from "./scenes/scene-roles"
import { SceneTeam } from "./scenes/scene-team"

const COMPONENTS = {
  intro: SceneIntro,
  architecture: SceneArchitecture,
  roles: SceneRoles,
  approval: SceneApproval,
  team: SceneTeam,
  business: SceneBusiness,
  outro: SceneOutro,
}

export function ShowcaseVideo() {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#f6f6f4",
        color: "#171717",
        fontFamily: SHOWCASE_FONT,
        overflow: "hidden",
      }}
    >
      <StageGrid />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 50% 40%, transparent 35%, rgba(23,23,23,0.045) 100%)",
          pointerEvents: "none",
        }}
      />
      {SCENES.map((scene) => {
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
