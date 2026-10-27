"use client"

import { useRef } from "react"
import { Player } from "@remotion/player"
import { Button } from "@/components/ui/button"
import { SCENES, VIDEO } from "@/lib/showcase-animation"
import { ShowcaseVideo } from "./showcase-video"

export function ShowcaseAnimationPlayer() {
  const playerRef = useRef(null)

  function jumpTo(event, from) {
    const player = playerRef.current
    if (!player) return
    player.seekTo(from)
    player.play(event)
  }

  return (
    <div className="space-y-3">
      <div className="mx-auto aspect-video w-full max-w-5xl overflow-hidden rounded-xl border bg-black shadow-sm">
        <Player
          ref={playerRef}
          component={ShowcaseVideo}
          durationInFrames={VIDEO.durationInFrames}
          compositionWidth={VIDEO.width}
          compositionHeight={VIDEO.height}
          fps={VIDEO.fps}
          controls
          loop
          autoPlay
          acknowledgeRemotionLicense
          clickToPlay
          spaceKeyToPlayOrPause
          doubleClickToFullscreen={false}
          showVolumeControls={false}
          style={{ width: "100%", height: "100%" }}
        />
      </div>

      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
        <span className="mr-1 text-xs text-muted-foreground">章节</span>
        {SCENES.map((scene) => (
          <Button
            key={scene.id}
            variant="outline"
            size="sm"
            onClick={(event) => jumpTo(event, scene.from)}
          >
            {scene.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          播放器支持暂停 / 全屏；点击章节可跳转
        </span>
      </div>
    </div>
  )
}
