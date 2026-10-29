"use client"

// Android 安装包下载按钮：**浏览器直连阿里云 OSS 取字节，再用 Blob 换个名字存盘**。
//
// 为什么不交给服务端（2026-10-29 实测定下来的）：
//   ① 阿里云默认域名禁止分发 .apk —— key 以 .apk 结尾、Content-Type 是 APK、
//      或 Content-Disposition 文件名以 .apk 结尾，三条命中任意一条就 400（签名地址也挡）。
//      所以桶里存的是 `client/dist/<资产名>.bin`（octet-stream、无 Content-Disposition）。
//   ② "由服务端补上文件名"也走不通：Vercel 香港函数连不上成都 OSS —— 连接稳定地在
//      10 秒后超时（构建环境却能连）。那条 /api/client/download 路由因此对谁都是 502。
// 浏览器（尤其国内用户的浏览器）到成都 OSS 又快又稳，桶的 CORS 已放行本站的 GET，
// 所以把"改名字"放在浏览器里做：fetch → Blob → `<a download="…apk">`。
//
// 代价：整包要在内存里过一遍（约 32MB）。换来的是直连 OSS 的速度、以及不依赖任何
// 中间服务器。失败时给一条 .bin 直链兜底（下载后手动去掉后缀）。文件名必须靠
// `download` 属性：Blob 的 MIME 只是给安装器的提示，存盘名字与它无关。
import { useCallback, useEffect, useRef, useState } from "react"
import { CheckIcon, DownloadIcon, LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { clientApkAliasKey } from "@/lib/client-assets.mjs"

const APK_MIME = "application/vnd.android.package-archive"
// NEXT_PUBLIC_ 前缀：构建时内联进客户端 bundle
const OSS_HOST = process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST

export function ApkDownload({ name, version = "", autoStart = false, className }) {
  const [state, setState] = useState("idle") // idle | downloading | done | error
  const [progress, setProgress] = useState(0)
  const busy = useRef(false)
  const autoStarted = useRef(false)
  const lastPct = useRef(-1)

  const aliasUrl = OSS_HOST
    ? `https://${OSS_HOST}/${clientApkAliasKey(name)}${version ? `?v=${encodeURIComponent(version)}` : ""}`
    : null

  const start = useCallback(async () => {
    if (busy.current) return
    if (!aliasUrl) {
      setState("error")
      return
    }
    busy.current = true
    lastPct.current = -1
    setState("downloading")
    setProgress(0)
    try {
      const res = await fetch(aliasUrl, { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error("浏览器不支持流式读取")
      const total = Number(res.headers.get("content-length")) || 0
      const reader = res.body.getReader()
      const chunks = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        // 只在百分比变化时更新：每 64KB 都 setState 会把低端机拖卡
        if (total) {
          const pct = Math.min(99, Math.floor((received / total) * 100))
          if (pct !== lastPct.current) {
            lastPct.current = pct
            setProgress(pct)
          }
        }
      }
      downloadBlob(new Blob(chunks, { type: APK_MIME }), name)
      setProgress(100)
      setState("done")
    } catch (err) {
      console.error("[apk-download] 下载失败", err)
      setState("error")
    } finally {
      busy.current = false
    }
  }, [aliasUrl, name])

  // 自动下载：客户端更新流程打开的 /download/apk 落地页用。
  // ref 守卫是给开发环境 React StrictMode 的双调用准备的——别下两遍。
  useEffect(() => {
    if (!autoStart || autoStarted.current) return
    autoStarted.current = true
    start()
  }, [autoStart, start])

  const label =
    state === "downloading"
      ? progress
        ? `正在下载 ${progress}%`
        : "正在下载…"
      : state === "done"
        ? "已开始下载"
        : state === "error"
          ? "重试下载"
          : "下载 APK"

  return (
    <div className={className}>
      <Button className="w-full" onClick={start} disabled={state === "downloading"}>
        {state === "downloading" ? (
          <LoaderCircleIcon className="size-4 animate-spin" />
        ) : state === "done" ? (
          <CheckIcon className="size-4" />
        ) : (
          <DownloadIcon className="size-4" />
        )}
        {label}
      </Button>

      {state === "done" && (
        <p className="mt-2 text-xs text-muted-foreground">
          已交给浏览器保存为 {name}，请到通知栏或下载列表里打开安装。
        </p>
      )}
      {state === "error" && (
        <p className="mt-2 text-xs text-muted-foreground">
          下载失败，请检查网络后重试。
          {aliasUrl && (
            <>
              {" "}
              也可以
              <a
                href={aliasUrl}
                className="underline underline-offset-2 hover:text-foreground"
              >
                直接下载
              </a>
              （保存后若不能安装，把文件名末尾的 .bin 去掉）。
            </>
          )}
        </p>
      )}
    </div>
  )
}

/// 把 Blob 交给浏览器存盘。**文件名只能靠 `download` 属性**——这正是整条链路存在的理由。
function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器拿到空文件；一分钟后再释放
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}
