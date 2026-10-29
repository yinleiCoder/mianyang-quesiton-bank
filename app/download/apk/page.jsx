// Android 安装包的**自动下载落地页**：客户端检查更新后点「去下载」打开的就是这里。
//
// 为什么需要一页 HTML 而不是直链：阿里云默认域名禁止分发 .apk，桶里只有 `.bin` 副本；
// 服务端也补不了文件名（Vercel 香港函数连不上成都 OSS，见 apk-download.jsx 的文件头）。
// 所以真正的下载由浏览器完成：本页加载后立刻 fetch OSS 的 `.bin`，转 Blob 存成 `.apk`。
//
// **已安装的旧客户端也会来这里**：清单里 APK 的 url 就指向本页（`?name=` 指明 ABI，
// `?v=` 只用于缓存键与展示），它们用系统浏览器打开，效果与新版一致。因此这一页
// 不能依赖登录、客户端版本或任何服务端数据。
import { APK_ALIAS_ASSETS, APK_ASSET } from "@/lib/client-assets.mjs"
import { ApkDownload } from "@/components/download/apk-download"

export const metadata = {
  title: "下载 Android 安装包",
  // 给更新流程用的落地页，不需要被搜索引擎收录
  robots: { index: false },
}

export default async function ApkDownloadPage({ searchParams }) {
  const sp = await searchParams
  // name 走白名单：别让这条 URL 变成"随便指定 OSS 对象"的入口
  const name = APK_ALIAS_ASSETS.includes(sp?.name) ? sp.name : APK_ASSET
  const version = typeof sp?.v === "string" ? sp.v : ""

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-6 text-center">
        <img
          src="/mianyang.svg"
          alt=""
          width={44}
          height={44}
          className="mx-auto size-11 object-contain"
        />
        <h1 className="mt-4 text-lg font-semibold tracking-tight">
          正在准备 Android 安装包
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {version ? `版本 ${version} · ` : ""}下载完成后请到通知栏或下载列表里打开安装
        </p>

        <ApkDownload name={name} version={version} autoStart className="mt-5" />

        <p className="mt-4 text-xs text-muted-foreground">
          首次安装需在系统设置里允许「安装未知来源应用」。
        </p>
        <a
          href="/download"
          className="mt-4 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          返回下载页
        </a>
      </div>
    </div>
  )
}
