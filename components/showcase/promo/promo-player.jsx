"use client"

import { useEffect, useMemo, useRef } from "react"
import { Player } from "@remotion/player"
import { prefetch, staticFile } from "remotion"
import { Button } from "@/components/ui/button"
import { PROMO_PLATFORMS, PROMO_VIDEO } from "@/lib/showcase-promo"
import { PromoVideo } from "./promo-video"

export function PromoPlayer({ platform = "windows" }) {
  const data = PROMO_PLATFORMS[platform] ?? PROMO_PLATFORMS.web
  const playerRef = useRef(null)
  const inputProps = useMemo(() => ({ platform }), [platform])
  const imagePaths = useMemo(
    () => data.chapters.flatMap((chapter) => chapter.images),
    [data]
  )

  // 只预取当前平台的分镜截图（网页 13 张 / Windows 11 张 / Android 20 张），
  // 切章节时不会出现空白帧。该版本的 prefetch() 不返回 Promise，不能链 .catch()。
  useEffect(() => {
    for (const src of imagePaths) {
      prefetch(staticFile(src))
    }
  }, [imagePaths])

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
          component={PromoVideo}
          inputProps={inputProps}
          durationInFrames={data.durationInFrames}
          compositionWidth={PROMO_VIDEO.width}
          compositionHeight={PROMO_VIDEO.height}
          fps={PROMO_VIDEO.fps}
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
        <Button variant="outline" size="sm" onClick={(event) => jumpTo(event, data.intro.from)}>
          片头
        </Button>
        {data.chapters.map((chapter) => (
          <Button
            key={chapter.id}
            variant="outline"
            size="sm"
            onClick={(event) => jumpTo(event, chapter.from)}
          >
            {chapter.label}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={(event) => jumpTo(event, data.outro.from)}>
          片尾
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          播放器支持暂停 / 全屏；点击章节可跳转
        </span>
      </div>
    </div>
  )
}
