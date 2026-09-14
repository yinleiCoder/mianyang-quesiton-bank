"use client"

// 通用 OSS 直传对话框：react-dropzone 选文件 → 本地预览 → 服务端预签名 → 浏览器直传。
// purpose 决定允许的类型/大小与服务端 key 前缀：
//   · question_media：图片/音频/视频/文件附件 ≤50MB，成功后调 register_media 登记（随草稿保存挂版本引用）；
//   · avatar：图片 ≤5MB，不登记（头像只写 profiles.avatar_url，避免 GC 误删）。
// 上传成功回调 onUploaded({ key, bucket, size, mime, kind, name })，由调用方决定写入位置。
import * as React from "react"
import { useDropzone } from "react-dropzone"
import { toast } from "sonner"
import { cn } from "cn"
import { createClient } from "@/lib/supabase/client"
import { uploadToOSS } from "@/lib/upload"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FileIcon, Loader2Icon, RefreshCwIcon, UploadCloudIcon } from "lucide-react"

const PURPOSE_CFG = {
  question_media: {
    accept: {
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/webp": [".webp"],
      "image/gif": [".gif"],
      "audio/mpeg": [".mp3"],
      "audio/wav": [".wav"],
      "audio/ogg": [".ogg"],
      "video/mp4": [".mp4"],
      "video/webm": [".webm"],
      "application/pdf": [".pdf"],
      "application/msword": [".doc"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.ms-excel": [".xls"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-powerpoint": [".ppt"],
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
      "text/plain": [".txt"],
      "text/markdown": [".md"],
      "text/csv": [".csv"],
    },
    maxMB: 50,
    hint: "图片、音视频或文档附件（≤50MB）；图片 png/jpg/webp/gif，音视频 mp3/wav/ogg/mp4/webm，附件 pdf/word/excel/ppt/txt/md/csv",
  },
  avatar: {
    accept: {
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/webp": [".webp"],
    },
    maxMB: 5,
    hint: "头像图片（≤5MB，png/jpg/webp），建议正方形",
  },
}

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
  const cfg = PURPOSE_CFG[purpose]
  const [file, setFile] = React.useState(null)
  const [previewUrl, setPreviewUrl] = React.useState(null) // 本地预览（文件可能尚未上传）
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [done, setDone] = React.useState(false)

  // 预览地址随所选文件的生命周期管理：换文件/清空/卸载时释放上一张。
  // 副作用只能放 effect——setState 的 updater 必须是纯函数（StrictMode 下会被重复调用）。
  React.useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const reset = React.useCallback(() => {
    setFile(null)
    setError("")
    setDone(false)
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: cfg.accept,
    disabled: busy,
    multiple: false,
    onDropRejected: (rejects) => {
      const code = rejects[0]?.errors?.[0]?.code
      if (code === "file-invalid-type") toast.error("不支持的文件类型")
      else if (code === "file-too-large") toast.error(`文件超过 ${cfg.maxMB}MB 上限`)
      else if (code === "too-many-files") toast.error("一次只能上传一个文件")
      else toast.error("无法读取该文件，请重试")
    },
    onDropAccepted: ([f]) => {
      setFile(f)
      setError("")
      setDone(false)
    },
  })

  // 打开对话框时重置内部状态（首屏不残留上次文件）
  React.useEffect(() => {
    if (open) reset()
  }, [open, reset])

  async function doUpload() {
    if (!file || busy) return
    setBusy(true)
    setError("")
    try {
      const meta = await uploadToOSS(file, purpose)
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
          <DialogDescription>{description ?? cfg.hint}</DialogDescription>
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
