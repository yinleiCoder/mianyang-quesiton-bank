// 软件宣传动画的数据入口：尺寸、分镜时间轴与两套平台的组合。
// 纯数据模块：不要 import React / Remotion / lucide。
import { ANDROID_CHAPTERS } from "./showcase-promo-android.js"
import { WEB_CHAPTERS } from "./showcase-promo-web.js"
import { WINDOWS_CHAPTERS } from "./showcase-promo-windows.js"

export const PROMO_VIDEO = { fps: 30, width: 1920, height: 1080 }
export const PROMO_INTRO_FRAMES = 120
export const PROMO_OUTRO_FRAMES = 150

function buildPlatform({ id, label, title, subtitle, accent, device, chapters }) {
  let from = PROMO_INTRO_FRAMES
  const built = chapters.map((item) => {
    const entry = { ...item, from }
    from += item.duration
    return entry
  })
  return {
    id, label, title, subtitle, accent, device,
    chapters: built,
    intro: { from: 0, duration: PROMO_INTRO_FRAMES },
    outro: { from, duration: PROMO_OUTRO_FRAMES },
    durationInFrames: from + PROMO_OUTRO_FRAMES,
  }
}

export const PROMO_PLATFORMS = {
  web: buildPlatform({
    id: "web",
    label: "网页 · 教师出题",
    title: "网页教师端",
    subtitle: "教师 / 管理端 · 出题、审批、组卷、讲评",
    accent: "emerald",
    device: "browser",
    chapters: WEB_CHAPTERS,
  }),
  windows: buildPlatform({
    id: "windows",
    label: "Windows 客户端",
    title: "Windows 学生端",
    subtitle: "机房电脑 / 宿舍笔记本 · 大屏刷题更舒服",
    accent: "violet",
    device: "desktop",
    chapters: WINDOWS_CHAPTERS,
  }),
  android: buildPlatform({
    id: "android",
    label: "Android 客户端",
    title: "Android 学生端",
    subtitle: "随身手机 · 碎片时间也能练",
    accent: "sky",
    device: "phone",
    chapters: ANDROID_CHAPTERS,
  }),
}
