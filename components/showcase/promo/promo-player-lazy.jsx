"use client"

// Remotion 只能在浏览器里播放：服务端页面只 import 这个壳，
// 由客户端 dynamic(ssr:false) 再加载真正的 Player 与 composition。
import dynamic from "next/dynamic"

export const PromoPlayerLazy = dynamic(
  () => import("./promo-player").then((m) => m.PromoPlayer),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto aspect-video w-full max-w-5xl animate-pulse rounded-xl border bg-muted" />
    ),
  }
)
