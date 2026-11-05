"use client"

// Remotion 只能在浏览器里播放：Server Component 不能 import remotion / @remotion/player，
// 否则会撞上 Remotion 的 RSC 检查（React.createContext is undefined）。
// 因此由服务端页面渲染本文件，本文件再 dynamic(ssr:false) 真正的 Player。
// 与 components/showcase/animation/showcase-animation-player-lazy.jsx 同一个范式。
import dynamic from "next/dynamic"

export const SchedulerPlayerLazy = dynamic(
  () => import("./scheduler-player").then((m) => m.SchedulerPlayer),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto aspect-video w-full max-w-5xl animate-pulse rounded-xl border bg-muted" />
    ),
  }
)
