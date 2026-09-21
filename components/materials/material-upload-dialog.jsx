"use client"

// 上传一份复习资料：填标题/简介/学科 + 选文件，一次提交。
//
// 为什么不直接用 components/media-uploader.jsx：那个对话框的契约是「选文件 → 上传 → 把结果
// 交回调用方」，它自己就关闭了；而资料必须先有标题与学科才能落库（0070 的 create_review_material）。
// 串两个对话框（先填信息再选文件）对用户是多余的一步，所以这里自己画一个。
//
// **但白名单与上限不在这里**：类型/大小仍全部取自 lib/media-spec.js 的
// acceptMap / tierFor / tooLargeMessage（真源），本组件只做派生——这条是 media-uploader.jsx
// 头部立下的规矩，照办。
import { useCallback, useEffect, useMemo, useState } from "react"
import { useDropzone } from "react-dropzone"
import { toast } from "sonner"
import { cn } from "cn"
import { createClient } from "@/lib/supabase/client"
import { uploadToOSS } from "@/lib/upload"
import { acceptMap, limitsHint, tierFor, tooLargeMessage } from "@/lib/media-spec"
import { nodePathOf } from "@/lib/subject-nodes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { UploadProgress } from "@/components/upload-progress"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TreePicker } from "@/components/admin/tree-picker"
import { FileIcon, Loader2Icon, UploadCloudIcon } from "lucide-react"

// 说明文字分两半：尺寸那半句从真源生成，扩展名那半句手写（与 media-uploader.jsx 同一取舍）。
const HINT_TAIL = "；pdf / word / excel / ppt / 图片 / 音视频 / txt / md / csv"

export function MaterialUploadDialog({ open, onOpenChange, nodes, onUploaded }) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [node, setNode] = useState(null)
  const [picking, setPicking] = useState(false)
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  // { loaded, total }；null = 还没开始收到进度（签名阶段或大文件刚起步）
  const [progress, setProgress] = useState(null)

  const accept = useMemo(() => acceptMap("material"), [])

  // 每次打开重置：上一次的残留（尤其是已选文件）会让人以为已经传过了
  useEffect(() => {
    if (!open) return
    setTitle("")
    setDescription("")
    setNode(null)
    setFile(null)
    setBusy(false)
    setProgress(null)
  }, [open])

  const onDrop = useCallback((accepted, rejected) => {
    const first = rejected?.[0]
    if (first) {
      const code = first.errors?.[0]?.code
      // 分档校验只能走 validator：react-dropzone 的 maxSize 是单一数值，表达不了
      // 「图片 20MB / 视频 1GB」（与 media-uploader.jsx 同款处理）
      toast.error(
        code === "file-too-large" ? tooLargeMessage("material", first.file.type) : "不支持的文件类型"
      )
      return
    }
    const picked = accepted?.[0]
    if (!picked) return
    setFile(picked)
    // 标题留空时用文件名（去掉扩展名）兜底，教师多数时候不用改
    setTitle((prev) => prev || picked.name.replace(/\.[^.]+$/, "").slice(0, 120))
  }, [])

  const validator = useCallback((f) => {
    const tier = tierFor("material", f.type)
    if (!tier) return { code: "file-invalid-type", message: "不支持的文件类型" }
    if (f.size > tier.maxBytes) {
      return { code: "file-too-large", message: tooLargeMessage("material", f.type) }
    }
    return null
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept,
    multiple: false,
    validator,
    onDrop,
  })

  async function submit() {
    if (!title.trim()) return toast.error("请填写标题")
    if (!node) return toast.error("请选择所属学科/专业大类")
    if (!file) return toast.error("请选择要上传的文件")

    setBusy(true)
    setProgress(null)
    try {
      // ① 直传 OSS（签名由服务端代签，客户端拿不到 AccessKey）。
      //    资料文档放宽到 2GB 之后这一步要按分钟算，必须给进度，否则用户会以为卡死。
      const meta = await uploadToOSS(file, "material", {
        onProgress: (loaded, total) => setProgress({ loaded, total }),
      })
      // ② 落库。key 由服务端生成，这里只把它交回去登记。
      const supabase = createClient()
      const { error } = await supabase.rpc("create_review_material", {
        p_object_key: meta.key,
        p_bucket: meta.bucket,
        p_size: meta.size,
        p_mime: meta.mime,
        p_title: title.trim(),
        p_description: description.trim() || null,
        p_course_node_id: node.id,
      })
      if (error) throw error

      toast.success("资料已上传，学生现在就能看到")
      onOpenChange(false)
      onUploaded?.()
    } catch (err) {
      // 上传成功但落库失败时，OSS 上会留一个没人引用的对象——不阻塞教师，如实提示即可
      console.error("资料上传失败", err)
      toast.error(err?.message || "上传失败，请稍后重试")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && !busy && onOpenChange(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>上传复习资料</DialogTitle>
            <DialogDescription>
              全市教师共享、学生可见。{limitsHint("material")}
              {HINT_TAIL}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="material-title">标题</Label>
              <Input
                id="material-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：办公应用期末复习提纲"
                maxLength={120}
                disabled={busy}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="material-desc">简介（可选）</Label>
              <Input
                id="material-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="一两句话说明这份资料覆盖什么内容"
                disabled={busy}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>所属学科 / 专业大类</Label>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setPicking(true)}
                className="justify-between"
              >
                <span className={cn("truncate", !node && "text-muted-foreground")}>
                  {node ? nodePathOf(nodes, node.id) : "选择学科或专业大类"}
                </span>
                <span className="shrink-0 text-muted-foreground">选择</span>
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>文件</Label>
              <div
                {...getRootProps()}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors",
                  isDragActive ? "border-primary bg-muted/60" : "hover:bg-muted/40",
                  busy && "pointer-events-none opacity-60"
                )}
              >
                <input {...getInputProps()} />
                {file ? (
                  <>
                    <FileIcon className="size-6 text-muted-foreground" />
                    <span className="max-w-full truncate text-sm">{file.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {(file.size / 1024 / 1024).toFixed(1)} MB · 点击可重新选择
                    </span>
                  </>
                ) : (
                  <>
                    {isDragActive ? (
                      <UploadCloudIcon className="size-6 text-primary" />
                    ) : (
                      <UploadCloudIcon className="size-6 text-muted-foreground" />
                    )}
                    <span className="text-sm">把文件拖到这里，或点击选择</span>
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                建议把 PPT / Word 先导出成 PDF 再上传 —— 只有 PDF 与图片学生能直接在线看，
                其余格式要点开交给系统程序（学生手机得装了 WPS 才打得开）。
              </p>
            </div>
          </div>

          {busy && (
            <UploadProgress loaded={progress?.loaded ?? 0} total={progress?.total ?? 0} />
          )}

          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={submit}>
              {busy ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" /> 上传中…
                </>
              ) : (
                <>
                  <UploadCloudIcon className="size-4" /> 上传并发布
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TreePicker
        open={picking}
        onOpenChange={setPicking}
        nodes={nodes}
        title="选择学科 / 专业大类"
        hint="资料按学科与专业大类组织，学生端就按这个筛。任意层级都可以挂。"
        onSelect={(picked) => {
          setNode(picked)
          setPicking(false)
        }}
        // 冻结的节点不再接收新内容（与题库同口径）
        pickable={(n) => !n.is_frozen}
      />
    </>
  )
}
