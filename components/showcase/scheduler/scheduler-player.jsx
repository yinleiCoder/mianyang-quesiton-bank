"use client"

import { useRef, useState } from "react"
import { Player } from "@remotion/player"
import { Button } from "@/components/ui/button"
import {
  SCHEDULER_DURATION,
  SCHEDULER_SCENES,
  SCHEDULER_VIDEO,
  sceneOf,
} from "@/lib/showcase-scheduler"
import { SchedulerVideo } from "./scheduler-video"

// 深链：/showcase/scheduler?scene=bkt 直接落在对应章节。
// 本组件由 lazy 包装以 ssr:false 加载，所以首帧就能读 window —— 不用 useSearchParams
// （那要求 Suspense 边界，且会把整个页面变成动态渲染）。
function readInitialScene() {
  if (typeof window === "undefined") return null
  return sceneOf(new URLSearchParams(window.location.search).get("scene"))
}

export function SchedulerPlayer() {
  const playerRef = useRef(null)
  const [initial] = useState(readInitialScene)

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
          component={SchedulerVideo}
          durationInFrames={SCHEDULER_DURATION}
          compositionWidth={SCHEDULER_VIDEO.width}
          compositionHeight={SCHEDULER_VIDEO.height}
          fps={SCHEDULER_VIDEO.fps}
          initialFrame={initial?.from ?? 0}
          controls
          loop
          // 带 scene 参数时不自动播放：用户是从某一章点进来的，
          // 自动从第 0 帧播起会把定位冲掉。
          autoPlay={!initial}
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
        {SCHEDULER_SCENES.map((scene) => (
          <Button
            key={scene.id}
            variant={initial?.id === scene.id ? "secondary" : "outline"}
            size="sm"
            onClick={(event) => jumpTo(event, scene.from)}
          >
            {scene.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {initial
            ? `已定位到「${initial.label}」；点击章节可切换`
            : "播放器支持暂停 / 全屏；点击章节可跳转"}
        </span>
      </div>
    </div>
  )
}
