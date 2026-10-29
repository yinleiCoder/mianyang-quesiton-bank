"use client"

// 客户端下载页的全部内容：**版本清单与安装包都由浏览器直连 OSS 取**。
//
// 为什么整页放在客户端：Vercel 香港函数连不上成都 OSS（2026-10-29 实测，连接稳定地
// 10 秒后超时；构建环境却能连），服务端渲染时读 latest.json 会失败——表现是版本号与
// SHA 列表静默消失。浏览器到 OSS 又快又稳，桶的 CORS 已放行本站的 GET，所以把取数
// 挪到浏览器：清单只是一次几 KB 的请求，APK 由组件自己去取（见 apk-download.jsx）。
//
// Windows 安装包仍是 OSS 直链（浏览器直接下，本来就没有跨域/文件名问题）；
// APK 的清单 url 指向 /download/apk 落地页，给已安装的客户端更新流程用。
import { useEffect, useState } from "react"
import {
  BookmarkIcon,
  BookOpenCheckIcon,
  ChartLineIcon,
  DownloadIcon,
  LaptopIcon,
  MonitorSmartphoneIcon,
  NotebookPenIcon,
  RepeatIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { APK_ASSET, WIN_SETUP_ASSET, WIN_ZIP_ASSET } from "@/lib/client-assets.mjs"
import { ApkDownload } from "@/components/download/apk-download"

const OSS_HOST = process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST
const OSS_BASE = OSS_HOST ? `https://${OSS_HOST}/client` : null

/** 清单字段归一：assets 是 [{ name, size, sha256, url }]。 */
function summarize(data) {
  const list = Array.isArray(data?.assets) ? data.assets : []
  const byName = new Map(list.filter((a) => a?.name).map((a) => [a.name, a]))
  const sha = (a) => String(a?.sha256 ?? "").toLowerCase()
  return {
    tag: data?.tag ?? null,
    assets: byName,
    hasSetup: byName.has(WIN_SETUP_ASSET),
    hasZip: byName.has(WIN_ZIP_ASSET),
    // 文件摘要，给"要不要信这个安装包"用
    sha256: [...byName].filter(([, a]) => sha(a)).map(([name, a]) => [name, sha(a)]),
  }
}

/** 某个资产的 OSS 直链：清单里的 url 优先，否则按资产名拼（只用于 Windows）。 */
function assetUrl(name, release) {
  const direct = release?.assets?.get(name)?.url
  if (direct) return direct
  if (!OSS_BASE) return null
  const v = release?.tag ? `?v=${encodeURIComponent(release.tag)}` : ""
  return `${OSS_BASE}/${name}${v}`
}

/// Windows 主按钮该指向哪：优先安装包，退而求其次压缩包。
function windowsDownload(release) {
  if (release?.hasSetup) return { url: assetUrl(WIN_SETUP_ASSET, release), setup: true }
  return { url: assetUrl(WIN_ZIP_ASSET, release), setup: false }
}

const FEATURES = [
  { icon: BookOpenCheckIcon, title: "刷题", desc: "即时判分与整卷两种模式，可选题量、打乱选项" },
  { icon: RepeatIcon, title: "背题", desc: "不记分、不占用练习记录，题干与答案一次性铺开" },
  { icon: TriangleAlertIcon, title: "错题本", desc: "做错的题自动收进来，随时重练" },
  { icon: BookmarkIcon, title: "收藏", desc: "挑出来的好题收进收藏夹，一键成套练习" },
  { icon: ChartLineIcon, title: "学情", desc: "练习记录、正确率与近两周趋势，一屏看完" },
  { icon: NotebookPenIcon, title: "记录", desc: "每套练习的作答与复盘都留着，可回看标准答案" },
]

export function DownloadPageClient() {
  // null = 清单还没到 / 取不到：按钮照常可用，只是没有版本号与 SHA 列表
  const [release, setRelease] = useState(null)

  useEffect(() => {
    if (!OSS_BASE) {
      console.error("[download] 没有配置 NEXT_PUBLIC_OSS_PUBLIC_HOST")
      return
    }
    let alive = true
    // 带时间戳绕开 OSS/CDN 的 60 秒缓存：发版后页面要立刻看到新版本号
    fetch(`${OSS_BASE}/latest.json?t=${Date.now()}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (alive) setRelease(summarize(data))
      })
      .catch((err) => {
        // **必须留痕**：静默失败会让"版本号对不上"变成一桩无头案
        console.error(`[download] OSS 清单取不到（${err?.message ?? err}）`)
      })
    return () => {
      alive = false
    }
  }, [])

  const win = windowsDownload(release)
  const zipUrl = assetUrl(WIN_ZIP_ASSET, release)
  const version = release?.tag ?? null
  // 所有资产都来自同一个 OSS 清单：版本号与文件摘要天然同源，便于核对
  const checks = release?.sha256 ?? []

  return (
    <div className="relative flex min-h-svh flex-1 flex-col bg-muted/40">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute bottom-0 right-[10%] h-56 w-56 rounded-full bg-sky-500/10 blur-3xl" />
      </div>

      <div className="relative mx-auto w-full max-w-3xl px-4 py-10 md:py-16">
        {/* 品牌区 */}
        <div className="flex items-center justify-center gap-2.5">
          <img
            src="/mianyang.svg"
            alt=""
            width={40}
            height={40}
            className="size-10 shrink-0 object-contain"
          />
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight">职教高考联盟</p>
            <p className="text-xs text-muted-foreground">多校共建 · 全市共享</p>
          </div>
        </div>

        <div className="mt-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            把题库装进口袋
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground">
            Android 与 Windows 双端刷题客户端，与网页端共用同一套题库和账号：
            网页端负责出题与审批，客户端负责刷题、背题与学情。
          </p>
          {version && (
            <p className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="px-1.5 py-0 text-xs">
                {version}
              </Badge>
              最新版本
            </p>
          )}
        </div>

        {/* 两个下载入口 */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <MonitorSmartphoneIcon className="size-4" /> Android
                {version && (
                  <Badge variant="outline" className="ml-auto px-1.5 py-0 text-xs">
                    {version}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>手机、平板（Android 7.0 及以上）</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ApkDownload name={APK_ASSET} version={version ?? ""} />
              <p className="text-xs text-muted-foreground">
                文件由浏览器直连阿里云 OSS 下载；首次安装需在系统设置里允许「安装未知来源应用」。
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <LaptopIcon className="size-4" /> Windows
                {version && (
                  <Badge variant="outline" className="ml-auto px-1.5 py-0 text-xs">
                    {version}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>Windows 10/11 64 位桌面端</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* 不再用 variant="secondary"：安装包现在是推荐路径，
                  灰按钮会让人以为它是次选。 */}
              {win.url ? (
                <Button
                  className="w-full"
                  nativeButton={false}
                  render={<a href={win.url} />}
                >
                  <DownloadIcon className="size-4" />
                  {win.setup ? "下载安装包" : "下载压缩包"}
                </Button>
              ) : (
                <Button className="w-full" disabled>
                  <DownloadIcon className="size-4" /> Windows 下载暂不可用
                </Button>
              )}

              {win.setup ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    双击安装即可，会自动创建桌面与开始菜单快捷方式；
                    <span className="font-medium">不需要管理员权限</span>，电脑上也不用另装运行库。
                  </p>
                  {zipUrl && (
                    <p className="text-xs text-muted-foreground">
                      免安装版：
                      <a
                        href={zipUrl}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        下载压缩包
                      </a>
                      （解压后运行整个目录里的 exe，只拷 exe 打不开）
                    </p>
                  )}
                </>
              ) : (
                // 走到这里说明**这个版本还没有安装包**（更早的 Release，或安装器那步构建失败）。
                // 文案要跟着换 —— 按钮上写着"下载压缩包"却还教人"双击安装"就成了驴唇不对马嘴。
                <p className="text-xs text-muted-foreground">
                  解压后运行目录里的 exe（<span className="font-medium">整个目录一起解压</span>，
                  只拷 exe 打不开）。下次发布起会提供双击即装的安装包。
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 版本与文件摘要：两者都来自同一份 OSS 清单，能自证"下到的就是这一版" */}
        {checks.length > 0 && (
          <details className="mt-6 rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer select-none">
              文件校验（SHA-256） · {version}
            </summary>
            <ul className="mt-2 space-y-2">
              {checks.map(([name, sha]) => (
                <li key={name}>
                  <span className="font-mono text-foreground/80">{name}</span>
                  <code className="mt-0.5 block break-all font-mono text-[10px] leading-relaxed">
                    {sha}
                  </code>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* 功能一览 */}
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <f.icon className="size-4 text-primary" />
                {f.title}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          客户端与网页端账号通用，无需单独注册。
        </p>

        <p className="mt-10 text-center text-xs text-muted-foreground">
          职教高考联盟 · 职业教育题库建设
        </p>
      </div>
    </div>
  )
}
