"use client"

// OSS 跨域探针（只在自检页 /dev-pdf-export 用）。
//
// 为什么单独探一下：导出时图片是**从浏览器直接 fetch OSS 拿字节**再嵌进 PDF 的，
// 所以 OSS 必须放行本站来源（名单维护在 scripts/oss-cors.mjs）。这条不放行时，
// 界面上看不出任何异常——图就是"没上去"，退化成一行说明文字。
// 探针用 HEAD 打一个不存在的 key：放行时得到 404（=跨域是通的），没放行时 fetch 直接抛错。
import { useState } from "react"
import { Button } from "@/components/ui/button"

export function CorsProbe() {
  const [result, setResult] = useState("")

  async function probe() {
    const host = process.env.NEXT_PUBLIC_OSS_PUBLIC_HOST
    if (!host) {
      setResult("没有配置 NEXT_PUBLIC_OSS_PUBLIC_HOST，这个环境本来就取不到图")
      return
    }
    setResult("探测中…")
    try {
      const res = await fetch(`https://${host}/__cors-probe__.png`, { method: "GET" })
      setResult(`跨域通（HTTP ${res.status}）——404 是对的，这个 key 本来就不存在`)
    } catch (e) {
      setResult(`跨域被拦：${e.message}。图片会退化成一行说明文字，其余导出照常。来源：${location.origin}`)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
      <Button type="button" variant="outline" size="sm" onClick={probe}>
        探测 OSS 跨域
      </Button>
      <span className="text-xs text-muted-foreground">
        {result || "点一下看看本站来源在不在 OSS 的放行名单里（换端口预览时最常见的问题）"}
      </span>
    </div>
  )
}
