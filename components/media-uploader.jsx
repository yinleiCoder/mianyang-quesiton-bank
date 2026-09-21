"use client"

// 通用 OSS 直传对话框：react-dropzone 选文件 → 本地预览 → 服务端预签名 → 浏览器直传。
// 允许的类型与大小上限的**真源在 lib/media-spec.js**（服务端预签名共用同一张表），本组件只做派生：
//   · question_media：图片 ≤20MB、音频 ≤200MB、视频 ≤1GB、文档 ≤200MB，成功后调 register_media 登记；
//   · avatar：图片 ≤5MB，不登记（头像只写 profiles.avatar_url，避免 GC 误删）。
// 上传成功回调 onUploaded({ key, bucket, size, mime, kind, name })，由调用方决定写入位置。
import { useCallback, useEffect, useMemo, useState } from "react"
import { useDropzone } from "react-dropzone"
import { toast } from "sonner"
import { cn } from "cn"
import { createClient } from "@/lib/supabase/client"
import { uploadToOSS } from "@/lib/upload"
import { acceptMap, limitsHint, tierFor, tooLargeMessage } from "@/lib/media-spec"
import { Button } from "@/components/ui/button"
import { UploadProgress } from "@/components/upload-progress"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FileIcon, Loader2Icon, RefreshCwIcon, UploadCloudIcon } from "lucide-react"

// 说明文字分两半：尺寸那半句由 limitsHint() 从真源生成，扩展名那半句手写——
// 自动生成会把 word 摊成 doc/docx，可读性反而更差。**新增类型时记得同步手写的那半句。**
const HINT_TAIL = {
  question_media: "；图片 png/jpg/webp/gif，音视频 mp3/wav/ogg/mp4/webm，附件 pdf/word/excel/ppt/txt/md/csv",
  avatar: "（png/jpg/webp），建议正方形",
}

const hintFor = (purpose) => `${limitsHint(purpose)}${HINT_TAIL[purpose] ?? ""}`

function KindLabel({ meta }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
      <FileIcon className="size-3.5" />
      {/* 既接受已上传的返回体（mime/kind），也接受待上传的浏览器 File（type，无 kind） */}
      {meta.mime ?? meta.type}
      {meta.kind !== "image" && ` · ${Math.ceil(meta.size / 1024)}KB`}
    </span>
  )
}

export function MediaUploaderDialog({
  purpose,
  open,
  onOpenChange,
  onUploaded,
  title = purpose === "avatar" ? "更换头像" : "插入图片 / 音视频 / 文件",
  description,
}) {
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null) // 本地预览（文件可能尚未上传）
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState(false)
  // { loaded, total }；null = 还没开始收到进度（签名阶段或大文件刚起步）
  const [progress, setProgress] = useState(null)

  // 预览地址随所选文件的生命周期管理：换文件/清空/卸载时释放上一张。
  // 副作用只能放 effect——setState 的 updater 必须是纯函数（StrictMode 下会被重复调用）。
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const reset = useCallback(() => {
    setFile(null)
    setError("")
    setDone(false)
    setProgress(null)
  }, [])

  const accept = useMemo(() => acceptMap(purpose), [purpose])

  // 分档校验只能走 validator：react-dropzone 的 maxSize 是单一数值，表达不了「图片 20MB / 视频 1GB」。
  // 返回的 message 与服务端 400 的文案同源（tooLargeMessage），两边不会各说各话。
  const validate = useCallback(
    (f) => {
      const tier = tierFor(purpose, f.type)
      if (!tier) return { code: "file-invalid-type", message: "不支持的文件类型" }
      if (f.size > tier.maxBytes) {
        return { code: "file-too-large", message: tooLargeMessage(purpose, f.type) }
      }
      return null
    },
    [purpose]
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept,
    validator: validate,
    disabled: busy,
    multiple: false,
    // 内置报错是英文（File is larger than… / File type must be…），不接管会直接漏给用户
    getErrorMessage: (error, f) => {
      if (error.code === "file-invalid-type") return "不支持的文件类型"
      if (error.code === "file-too-large") return tooLargeMessage(purpose, f.type)
      if (error.code === "too-many-files") return "一次只能上传一个文件"
      return "无法读取该文件，请重试"
    },
    onDropRejected: (rejects) => {
      // message 已由 getErrorMessage 本地化（含 validator 自己返回的那条）
      toast.error(rejects[0]?.errors?.[0]?.message ?? "无法读取该文件，请重试")
    },
    onDropAccepted: ([f]) => {
      setFile(f)
      setError("")
      setDone(false)
    },
  })

  // 打开对话框时重置内部状态（首屏不残留上次文件）
  useEffect(() => {
    if (open) reset()
  }, [open, reset])

  async function doUpload() {
    if (!file || busy) return
    setBusy(true)
    setError("")
    setProgress(null)
    try {
      const meta = await uploadToOSS(file, purpose, {
        // 只在上传阶段有回调；签名那一步没有进度，此时仍显示"上传中…"
        onProgress: (loaded, total) => setProgress({ loaded, total }),
      })
      if (purpose === "question_media") {
        const supabase = createClient()
        const { error: rpcErr } = await supabase.rpc("register_media", {
          p_object_key: meta.key,
          p_bucket: meta.bucket,
          p_size: meta.size,
          p_mime: meta.mime,
        })
        if (rpcErr) throw new Error(`媒体登记失败：${rpcErr.message}`)
      }
      setDone(true)
      onUploaded({ ...meta, name: file.name })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onOpenChange(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? hintFor(purpose)}</DialogDescription>
        </DialogHeader>

        {done && file ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <UploadCloudIcon className="size-10 text-emerald-600" />
            <p className="text-sm font-medium">上传成功</p>
            <p className="text-xs text-muted-foreground">已在本地生效，保存题目/资料后即可正常使用。</p>
          </div>
        ) : (
          <>
            <div
              {...getRootProps()}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors",
                isDragActive ? "border-primary bg-primary/5" : "border-border hover:bg-accent/50",
                busy && "pointer-events-none opacity-60"
              )}
            >
              <input {...getInputProps()} />
              {file ? (
                <>
                  {file.type.startsWith("image/") && previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewUrl} alt="预览" className="max-h-48 rounded-lg object-contain" />
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <FileIcon className="size-5" />
                      <span className="max-w-60 truncate font-medium text-foreground">{file.name}</span>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">{file.name}</p>
                </>
              ) : (
                <>
                  <UploadCloudIcon className="size-8 text-muted-foreground" />
                  <p className="text-sm font-medium">点击选择或拖拽文件到此处</p>
                </>
              )}
            </div>
            {file && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <KindLabel meta={file} />
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={reset}>
                  <RefreshCwIcon className="size-3.5" /> 重新选择
                </Button>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {busy && <UploadProgress loaded={progress?.loaded ?? 0} total={progress?.total ?? 0} />}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy || done} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={!file || busy || done} onClick={doUpload}>
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            {busy ? "上传中…" : purpose === "avatar" ? "上传并保存" : "上传并插入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
