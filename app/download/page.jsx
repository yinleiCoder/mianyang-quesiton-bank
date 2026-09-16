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
    "绵阳市中职共建题库的 Android 与 Windows 客户端：与网页端共用同一套题库和账号，随手刷题、背题、看学情。",
}

const REPO = "yinleiCoder/mianyang-quiz"
const RELEASES = `https://github.com/${REPO}/releases`
// 资产名固定（不带版本号），所以这三个链接长期有效
const APK_URL = `${RELEASES}/latest/download/mianyang_quiz-android.apk`
const ZIP_URL = `${RELEASES}/latest/download/mianyang_quiz-windows-x64.zip`

// 最近一个 Release 的版本号，只用于展示；取不到（还没发过版、或接口限流）就返回 null，
// 页面照常显示，不因为一个装饰性字段把整页拖垮。
async function latestRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    const data = await res.json()
    return { tag: data.tag_name, publishedAt: data.published_at }
  } catch {
    return null
  }
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
            <p className="text-base font-semibold tracking-tight">绵阳市中职共建题库</p>
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
                render={<a href={APK_URL} />}
              >
                <DownloadIcon className="size-4" /> 下载 APK
              </Button>
              <p className="text-xs text-muted-foreground">
                首次安装需在系统设置里允许「安装未知来源应用」。
              </p>
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
              <Button
                className="w-full"
                variant="secondary"
                nativeButton={false}
                render={<a href={ZIP_URL} />}
              >
                <DownloadIcon className="size-4" /> 下载压缩包
              </Button>
              <p className="text-xs text-muted-foreground">
                解压后运行目录里的 exe（<span className="font-medium">整个目录一起解压</span>，只拷 exe 打不开）；
                若提示缺少 vcruntime140.dll，装一次 Microsoft Visual C++ 运行库。
              </p>
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
          绵阳市教育与体育局 · 职业教育题库建设
        </p>
      </div>
    </div>
  )
}
