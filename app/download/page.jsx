// 客户端下载页（公开页，不需要登录）。产品页的用途有两个：
//   1. 让老师在网页端就能把客户端发给学生（侧栏有入口）；
//   2. 客户端内的「发现新版本」也指向这里/Release 页，两边用同一批链接。
//
// 下载链接写的是 GitHub 的 /releases/latest/download/<固定资产名> —— 永远指向最新版，
// 不需要任何接口调用，也不会随版本号漂移（发布流水线特意把资产名固定成不带版本号，
// 见客户端仓库的 .github/workflows/release.yml）。版本号只用于展示，取不到就整块不渲染。
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
  ArrowUpRightIcon,
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

const REPO = "yinleiCoder/mianyang-quiz"
const RELEASES = `https://github.com/${REPO}/releases`
// 资产名固定（不带版本号），所以这几个链接长期有效。
// Asset 名与客户端仓库流水线里的**逐字一致**（那边特意不带版本号）。
// Windows 默认给**安装包**：双击装完，自动建桌面快捷方式，不需要管理员权限，
// 也不用管 C 运行库（随包带着）。zip 留给需要绿色版的人，是次要入口。
const APK_ASSET = "mianyang_quiz-android.apk"
const WIN_SETUP_ASSET = "mianyang_quiz-windows-x64-setup.exe"
const WIN_ZIP_ASSET = "mianyang_quiz-windows-x64.zip"

// **两条线路：自家 OSS 优先，GitHub 只作备用。**
// 2026-10-12 在绵阳实测：GitHub 的 release 资产 20 秒拿不到一个字节（HEAD 能过、正文取不到），
// 同一时刻自家成都 OSS 7.2MB/s。链接正确不代表下得动——学生只会看到一个永远转圈的下载。
// 客户端仓库的发布流水线把同一批资产推到 OSS（tool/upload_to_oss.mjs），
// 资产名两边逐字一致，所以这里只是换个前缀。
const OSS_HOST = process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST
const OSS_BASE = OSS_HOST ? `https://${OSS_HOST}/client` : null

// 第三方 GitHub 加速镜像，给**上不了 OSS 的那一个资产**用（目前只有 .apk —— 阿里云不允许
// .apk 从 OSS 默认域名对外分发，实测回 400 ApkDownloadForbidden）。
// **它不是我们的基础设施**：可用性随时可能变，理论上也能替换文件。所以下面把 SHA-256
// 印在页面上让人能自证——那个摘要来自 GitHub 官方 Release 的 digest，逐字节核对过。
// 2026-10-12 实测：镜像 140~230KB/s（对照 GitHub 直连 20 秒 0 字节、自家 OSS 9.6MB/s）。
// 想换镜像只改这一行；若哪天给桶绑了自定义域名，APK 也会自动走 OSS（见 assetUrl）。
const GITHUB_MIRROR = "https://ghproxy.net/"

/** 某个资产该走哪条线路：清单说它已在 OSS 上就用 OSS，否则走 GitHub 加速镜像。 */
function assetUrl(name, release) {
  return OSS_BASE && release?.mirrored?.has(name)
    ? `${OSS_BASE}/${name}`
    : `${GITHUB_MIRROR}${RELEASES}/latest/download/${name}`
}

// 最近一个 Release 的版本号、**它实际带了哪些资产**，以及该走哪条线路。
// 取不到就返回 null，页面照常显示——不因为一个装饰性字段把整页拖垮。
//
// 为什么要看资产列表：安装包是后加的资产，**比它更早的 Release 里只有 zip**。
// 而固定名的下载链接在资产不存在时是 **404** —— 不查就点，用户拿到的是一个死链
//（安装器那一步构建失败时也会出现这种情况）。
async function latestRelease() {
  return (await ossRelease()) ?? (await githubRelease())
}

/** 首选：发布流水线写在 OSS 上的 client/latest.json（国内快）。 */
async function ossRelease() {
  if (!OSS_BASE) return null
  try {
    const res = await fetch(`${OSS_BASE}/latest.json`, { next: { revalidate: 300 } })
    if (!res.ok) return null
    const data = await res.json()
    return { ...summarize(data.tag, data.publishedAt, data.assets), source: "oss" }
  } catch {
    return null
  }
}

/** 兜底：GitHub API（权威但慢；OSS 清单还没写过的版本只能走这条）。 */
async function githubRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    const data = await res.json()
    return { ...summarize(data.tag_name, data.published_at, data.assets), source: "github" }
  } catch {
    return null
  }
}

/** 两份来源（OSS 的 latest.json / GitHub 的 release JSON）字段名不同，在这里归一。 */
function summarize(tag, publishedAt, assets) {
  const list = assets ?? []
  const names = new Set(list.map((a) => a.name))
  // 摘要：GitHub 给的是 "sha256:…" 形式的 digest，OSS 清单里是裸的 sha256
  const sha = (a) => (a.sha256 ?? a.digest?.replace(/^sha256:/, "") ?? "").toLowerCase()
  return {
    tag,
    publishedAt,
    hasSetup: names.has(WIN_SETUP_ASSET),
    hasZip: names.has(WIN_ZIP_ASSET),
    // 已经在自家 OSS 上的资产。**只认显式的 mirrored: true**：GitHub 那份清单没有这个字段
    //（那边我们不知道 OSS 上有什么），于是全部落回 GitHub 线路——正是想要的保守行为。
    // 目前只有 .apk 是这条：阿里云不允许它从 OSS 默认域名分发（见 AGENTS.md 与
    // 客户端仓库 tool/upload_to_oss.mjs），清单里标记 mirrored:false。
    mirrored: new Set(list.filter((a) => a.mirrored === true).map((a) => a.name)),
    // 文件摘要，给"要不要信这个安装包"用（走第三方镜像时尤其需要）
    sha256: new Map(list.filter((a) => sha(a)).map((a) => [a.name, sha(a)])),
  }
}

/// Windows 主按钮该指向哪：优先安装包，退而求其次压缩包，再不行去 Release 页自己找。
///
/// **查不到资产列表时（release 为 null）选 zip**：那说明清单挂了或被限流，
/// 而 zip 是历来每个版本都有、几乎不会缺的那个。宁可给用户一个能用的旧形态，
/// 也不要赌一个可能 404 的链接。
function windowsDownload(release) {
  const url = (name) => assetUrl(name, release)
  if (!release) return { url: url(WIN_ZIP_ASSET), setup: false }
  if (release.hasSetup) return { url: url(WIN_SETUP_ASSET), setup: true }
  if (release.hasZip) return { url: url(WIN_ZIP_ASSET), setup: false }
  return { url: RELEASES, setup: false }
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
  // 安卓包走的是第三方加速镜像，把摘要摆出来让人能自证（见 GITHUB_MIRROR 的注释）
  const apkSha = release?.sha256?.get(APK_ASSET) ?? ""

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
          {release && (
            <p className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="px-1.5 py-0 text-xs">
                {release.tag}
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
              </CardTitle>
              <CardDescription>手机、平板（Android 7.0 及以上）</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                className="w-full"
                nativeButton={false}
                render={<a href={apkUrl} />}
              >
                <DownloadIcon className="size-4" /> 下载 APK
              </Button>
              <p className="text-xs text-muted-foreground">
                首次安装需在系统设置里允许「安装未知来源应用」。
              </p>
              {/* 安卓包经过第三方加速镜像，摘要摆出来让人能自证；默认收起，不打扰多数人 */}
              {apkSha && (
                <details className="text-xs text-muted-foreground">
                  <summary className="w-fit cursor-pointer select-none">
                    文件校验（SHA-256）
                  </summary>
                  <code className="mt-1 block break-all font-mono text-[10px] leading-relaxed">
                    {apkSha}
                  </code>
                </details>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <LaptopIcon className="size-4" /> Windows
              </CardTitle>
              <CardDescription>Windows 10/11 64 位桌面端</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* 不再用 variant="secondary"：安装包现在是推荐路径，
                  灰按钮会让人以为它是次选。 */}
              <Button
                className="w-full"
                nativeButton={false}
                render={<a href={win.url} />}
              >
                <DownloadIcon className="size-4" />
                {win.setup ? "下载安装包" : "下载压缩包"}
              </Button>

              {win.setup ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    双击安装即可，会自动创建桌面与开始菜单快捷方式；
                    <span className="font-medium">不需要管理员权限</span>，电脑上也不用另装运行库。
                  </p>
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

        <p className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <a
            href={RELEASES}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
          >
            查看所有版本与更新说明 <ArrowUpRightIcon className="size-3" />
          </a>
          <span>客户端与网页端账号通用，无需单独注册。</span>
        </p>

        <p className="mt-10 text-center text-xs text-muted-foreground">
          职教高考联盟 · 职业教育题库建设
        </p>
      </div>
    </div>
  )
}
