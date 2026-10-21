// 客户端下载页（公开页，不需要登录）。
//
// 线路分工（2026-10-21 用户拍板改回 gh-proxy）：
//   · 版本清单 latest.json 与 Windows 安装包/zip 走自家阿里云 OSS（快、可控）；
//   · **APK 走 gh-proxy 加速**：阿里云禁止 .apk 从 OSS 默认域名（*.aliyuncs.com）
//     对外分发，而绑定自定义域名要求大陆备案，短期走不通。gh-proxy 是可配置的
//     第三方加速前缀，页面上的 SHA-256 仍来自 OSS 清单，供用户自证文件。
//
// 本页与客户端检查更新读同一份 OSS `client/latest.json`，版本号（tag）同源；
// APK 的实际下载地址由 `release.tag` + 固定资产名拼出，不会出现"页面 v2.8.1、
// 下到 v2.8.0"的漂移。
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  DownloadIcon,
  LaptopIcon,
  MonitorSmartphoneIcon,
  BookOpenCheckIcon,
  RepeatIcon,
  BookmarkIcon,
  TriangleAlertIcon,
  NotebookPenIcon,
  ChartLineIcon,
} from "lucide-react"

export const metadata = {
  title: "下载客户端",
  description:
    "职教高考联盟的 Android 与 Windows 客户端：与网页端共用同一套题库和账号，随手刷题、背题、看学情。",
}

// 资产名固定（不带版本号），所以把名字换成别的会导致 404。
// Asset 名与客户端仓库流水线里的**逐字一致**（那边特意不带版本号）。
// Windows 默认给**安装包**：双击装完，自动建桌面快捷方式，不需要管理员权限，
// 也不用管 C 运行库（随包带着）。zip 留给需要绿色版的人，是次要入口。
const APK_ASSET = "mianyang_quiz-android.apk"
const WIN_SETUP_ASSET = "mianyang_quiz-windows-x64-setup.exe"
const WIN_ZIP_ASSET = "mianyang_quiz-windows-x64.zip"

// gh-proxy 加速前缀：换节点只改环境变量 NEXT_PUBLIC_GH_PROXY（末尾带 /）。
// 默认用实测可用的 gh-proxy.com；ghproxy.net 在 2026-10-21 的测试里明显更慢。
const GH_PROXY =
  (process.env.NEXT_PUBLIC_GH_PROXY || "https://gh-proxy.com/").replace(/\/+$/, "") + "/"
const REPO = "yinleiCoder/mianyang-quiz"

/** GitHub Release 资产地址（经 gh-proxy 加速）。优先钉到清单里的 tag，避免 latest 漂移。 */
function githubAssetUrl(name, release) {
  const path = release?.tag
    ? `releases/download/${encodeURIComponent(release.tag)}/${name}`
    : `releases/latest/download/${name}`
  return `${GH_PROXY}https://github.com/${REPO}/${path}`
}

// 清单固定放在 OSS 默认域名上（JSON 不受 .apk 限制，也不依赖自定义域名是否已绑好）。
// 资产直链来自清单里的 url；只有旧清单没有 url 时才用这个前缀兜底。
const OSS_HOST = process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST
const OSS_BASE = OSS_HOST ? `https://${OSS_HOST}/client` : null

/** 某个资产的下载地址：清单里的 OSS 直链优先；APK 固定走 gh-proxy。 */
function assetUrl(name, release) {
  const direct = release?.assets?.get(name)?.url
  if (direct) return direct
  // APK 在 OSS 默认域名上会被阿里云 400 拦掉（绑定自定义域名要备案，短期不可行）
  if (name.toLowerCase().endsWith(".apk")) return githubAssetUrl(name, release)
  if (!OSS_BASE) return githubAssetUrl(name, release)
  const v = release?.tag ? `?v=${encodeURIComponent(release.tag)}` : ""
  return `${OSS_BASE}/${name}${v}`
}

// 最近一个版本的版本号与**它实际带了哪些资产**。取不到就返回 null，页面照常显示——
// 不因为一个装饰性字段把整页拖垮，也不退回 GitHub（国内那条线路本来就下不动）。
async function latestRelease() {
  if (!OSS_BASE) {
    console.error("[download] 没有配置 NEXT_PUBLIC_OSS_PUBLIC_HOST，无法读取 OSS 下载清单")
    return null
  }
  try {
    // 清单本身只有几十 KB，60 秒重验证：发布后一分钟内页面就能看到新版本号。
    const res = await fetch(`${OSS_BASE}/latest.json`, { next: { revalidate: 60 } })
    if (!res.ok) {
      // **必须留痕**：静默 return null 会让"版本号对不上"变成一桩无头案。
      console.error(`[download] OSS 清单响应 ${res.status}`)
      return null
    }
    const data = await res.json()
    return summarize(data.tag, data.publishedAt, data.assets)
  } catch (err) {
    console.error(`[download] OSS 清单取不到（${err?.message ?? err}）`)
    return null
  }
}

/** 清单字段归一：assets 是 [{ name, size, sha256, url }]。 */
function summarize(tag, publishedAt, assets) {
  const list = Array.isArray(assets) ? assets : []
  const byName = new Map(list.filter((a) => a?.name).map((a) => [a.name, a]))
  const sha = (a) => String(a?.sha256 ?? "").toLowerCase()
  return {
    tag,
    publishedAt,
    assets: byName,
    hasSetup: byName.has(WIN_SETUP_ASSET),
    hasZip: byName.has(WIN_ZIP_ASSET),
    // 文件摘要，给"要不要信这个安装包"用
    sha256: new Map([...byName].filter(([, a]) => sha(a)).map(([name, a]) => [name, sha(a)])),
  }
}

/// Windows 主按钮该指向哪：优先安装包，退而求其次压缩包。
///
/// **查不到资产列表时（release 为 null）选 zip**：zip 是历来每个版本都有的形态，
/// 默认 OSS 域名也能直接下；宁可给能用的旧形态，也不要赌一个可能 404 的链接。
function windowsDownload(release) {
  const url = (name) => assetUrl(name, release)
  if (release?.hasSetup) return { url: url(WIN_SETUP_ASSET), setup: true }
  if (release?.hasZip) return { url: url(WIN_ZIP_ASSET), setup: false }
  return { url: url(WIN_ZIP_ASSET), setup: false }
}

const FEATURES = [
  { icon: BookOpenCheckIcon, title: "刷题", desc: "即时判分与整卷两种模式，可选题量、打乱选项" },
  { icon: RepeatIcon, title: "背题", desc: "不记分、不占用练习记录，题干与答案一次性铺开" },
  { icon: TriangleAlertIcon, title: "错题本", desc: "做错的题自动收进来，随时重练" },
  { icon: BookmarkIcon, title: "收藏", desc: "挑出来的好题收进收藏夹，一键成套练习" },
  { icon: ChartLineIcon, title: "学情", desc: "练习记录、正确率与近两周趋势，一屏看完" },
  { icon: NotebookPenIcon, title: "记录", desc: "每套练习的作答与复盘都留着，可回看标准答案" },
]

export default async function DownloadPage() {
  const release = await latestRelease()
  const win = windowsDownload(release)
  const apkUrl = assetUrl(APK_ASSET, release)
  const zipUrl = assetUrl(WIN_ZIP_ASSET, release)
  const version = release?.tag ?? null
  // 所有资产都来自同一个 OSS 清单：版本号与文件摘要天然同源，便于核对
  const checks = release ? [...release.sha256.entries()] : []

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
              {apkUrl ? (
                <Button
                  className="w-full"
                  nativeButton={false}
                  render={<a href={apkUrl} />}
                >
                  <DownloadIcon className="size-4" /> 下载 APK
                </Button>
              ) : (
                <Button className="w-full" disabled>
                  <DownloadIcon className="size-4" /> Android 下载暂不可用
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                {apkUrl
                  ? "经 gh-proxy 加速下载；首次安装需在系统设置里允许「安装未知来源应用」。"
                  : "下载地址生成失败，请稍后再试。"}
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
