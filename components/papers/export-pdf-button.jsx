"use client"

// 「下载 PDF」按钮。纯客户端动作：不经过服务器、不占函数时长（与 AI 分析同一条路），
// react-pdf 与字体全部动态 import——不点导出，这些字节就不进任何人的首屏包。
//
// 与「打印 / 保存为 PDF」是两条并存的出口，不是替代关系：打印那条走浏览器排版引擎，
// 中文靠系统字体，什么都不用带；这条是**自己排版**，所以要内嵌字体、要自己嵌图。
// 好处是拿走的就是一份 PDF 文件，不依赖用户会不会在打印对话框里选「另存为」。
import { useState } from "react"
import { FileDownIcon, Loader2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { collectText, collectMediaKeys, prefetchImages } from "@/lib/pdf-prep"
import { missingGlyphs, registerPdfFonts } from "@/lib/pdf-fonts"

// 文件名：去掉 Windows 不让命名的字符，太长截一下（有的卷名能写一长句）
function fileName(snapshot, withAnswers) {
  const base = String(snapshot?.title ?? "试卷")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
  return `${base || "试卷"}${withAnswers ? "（参考答案）" : ""}.pdf`
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让某些浏览器来不及取磁盘上的数据，留一段时间再放
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function ExportPdfButton({ snapshot, mode = "paper", label, hint }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  const withAnswers = mode === "answers"

  async function run() {
    setBusy(true)
    try {
      setNote("正在载入字体…")
      await registerPdfFonts()

      const keys = collectMediaKeys(snapshot, { withAnswers })
      let images = new Map()
      if (keys.length > 0) {
        setNote(`正在准备图片 0/${keys.length}…`)
        images = await prefetchImages(keys, (done, total) => setNote(`正在准备图片 ${done}/${total}…`))
      }

      // 缺字先提示、不拦路：子集字体装不下 GB2312 之外的字，缺的那个位置会是空白。
      // 导不导出交给用户决定——为一两个生僻字挡住整份卷子的导出不值得。
      const missing = missingGlyphs(collectText(snapshot, { withAnswers }))
      if (missing.length > 0) {
        toast.warning(`有 ${missing.length} 个字没有字形，导出的 PDF 里会是空白`, {
          duration: 8000,
          description: `${missing.slice(0, 12).join("")}${missing.length > 12 ? "…" : ""}　补法：加进 scripts/cjk-extra-chars.txt 后重跑 scripts/build-cjk-subset.mjs`,
        })
      }

      setNote("正在排版…")
      const [{ pdf }, { PaperPdfDocument }] = await Promise.all([
        import("@react-pdf/renderer"),
        import("@/components/papers/paper-pdf-document"),
      ])
      const blob = await pdf(<PaperPdfDocument snapshot={snapshot} mode={mode} images={images} />).toBlob()
      saveBlob(blob, fileName(snapshot, withAnswers))
      setNote("")
      toast.success("已导出 PDF", { description: `${Math.round(blob.size / 1024)} KB` })
    } catch (e) {
      // 导出是辅助动作：失败了说清原因，不要吞掉让人以为点了没反应
      setNote("")
      toast.error("导出失败", { description: e?.message ?? String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={run}>
        {busy ? <Loader2Icon className="size-4 animate-spin" /> : <FileDownIcon className="size-4" />}
        {busy ? "正在导出…" : (label ?? (withAnswers ? "下载答案 PDF" : "下载 PDF"))}
      </Button>
      <span className="text-xs text-muted-foreground">{busy ? note : hint}</span>
    </div>
  )
}
