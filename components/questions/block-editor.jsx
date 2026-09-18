"use client"

// 内容块编辑器：文本段落块（textarea 逐段）+ 媒体块（经 OSS 直传插入；已存在媒体只读展示、可删除）。
// 双向契约：值即内容块数组 [{t:'text'|'media',...}]，直接落入 DB content（无中间格式，历史版本块永不改写）。
// 媒体块只存相对 key（服务端生成，qbank/…），展示时拼 CNAME 公网域名（见 lib/oss-url）。
// 类型策略：题干/材料/解析/选项都可插图、音视频与文件附件（mediaLabel）。
// noMedia 仍然保留给**真正纯文字**的场景（如填空题的空的说明文案），但选项已不再属于这类：
// 选项的 label 本来就是块数组，两端也都能渲染图片块，编辑器原先拦着只是历史遗留。
import { useState } from "react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { MediaUploaderDialog } from "@/components/media-uploader"
import { mediaUrl } from "@/lib/oss-url"
import { FileIcon, ImagePlusIcon, PlusIcon, Trash2Icon } from "lucide-react"

// 文件块展示名：优先存原始文件名（alt），兜底从 key 提炼扩展名
function fileDisplayName(b) {
  if (b.alt) return b.alt
  const key = b.key ?? b.url ?? ""
  const base = key.slice(key.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot >= 0 ? `附件文件${base.slice(dot)}` : "附件文件"
}

export function BlockEditor({
  blocks,
  onChange,
  placeholder = "输入内容…（可分段；需要图片/音视频/文件时点下方插入）",
  mediaLabel = "插入图片/音视频/文件",
  minRows = 3,
  compact = false, // 紧凑模式（选项等小字段）：无文本段落按钮
  noMedia = false, // 纯文字场景（选项）：不渲染任何媒体插入入口
  className = "",
}) {
  const list = blocks ?? []
  const [autoFocusIdx, setAutoFocusIdx] = useState(null)
  const [mediaOpen, setMediaOpen] = useState(false)

  // 处理器直接用本次渲染的 list：onChange 后父层必然重渲染，闭包不会读到更旧的值。
  // （原先在渲染期写 ref 违反 Rules of React，会让 React Compiler 直接放弃优化整个编辑器。）
  const setBlock = (i, patch) =>
    onChange(list.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))

  const addParagraph = () => {
    onChange([...list, { t: "text", text: "" }])
    setAutoFocusIdx(list.length)
  }
  const removeAt = (i) => {
    onChange(list.filter((_, idx) => idx !== i))
  }

  const isEmpty = list.length === 0
  // 空态渲染成一个"幽灵文本段"，与真实段共用同一棵 DOM（同为 key=0 的 div>textarea）：
  // 若空态用裸 Textarea、有字后再切成包裹 div，元素类型变化触发重挂载 → 输入首字即失焦。
  const items = isEmpty ? [{ _ghost: true }] : list

  return (
    <div className={`space-y-1.5 ${className}`}>
      {items.map((b, i) => {
        if (!b._ghost && b.t === "media") {
          const src = mediaUrl(b.key ?? b.url)
          return (
            <div key={i} className="flex items-start gap-2 rounded-lg border bg-muted/40 p-2">
              <div className="min-w-0 flex-1">
                {!src ? (
                  <p className="px-1 py-2 text-sm text-muted-foreground">媒体地址无效</p>
                ) : b.kind === "audio" ? (
                  <audio controls src={src} className="h-9 w-full" />
                ) : b.kind === "video" ? (
                  <video controls src={src} className="max-h-48 rounded-md" />
                ) : b.kind === "file" ? (
                  <a
                    href={src}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs hover:bg-accent"
                  >
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{fileDisplayName(b)}</span>
                    <span className="shrink-0 text-muted-foreground">查看/下载附件</span>
                  </a>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src} alt={b.alt ?? ""} className="max-h-48 rounded-md object-contain" />
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => removeAt(i)}
                aria-label="移除媒体"
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          )
        }
        const ghost = b._ghost === true
        const text = ghost ? "" : b.text ?? ""
        return (
          <div key={i} className="group relative">
            <Textarea
              autoFocus={autoFocusIdx === i}
              placeholder={placeholder}
              minRows={
                ghost
                  ? minRows
                  : b.text.includes("\n")
                    ? Math.min(6, Math.max(minRows, b.text.split("\n").length))
                    : minRows
              }
              value={text}
              onChange={(e) =>
                ghost ? onChange([{ t: "text", text: e.target.value }]) : setBlock(i, { text: e.target.value })
              }
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter 便捷分段
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault()
                  addParagraph()
                }
              }}
              className="pr-8"
            />
            {!ghost && (
              <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label="删除此段"
                  onClick={() => removeAt(i)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        )
      })}
      {!(compact && noMedia) && (
        <div className="flex items-center gap-2 pt-0.5">
          {!isEmpty && !compact && (
            <Button type="button" variant="ghost" size="sm" onClick={addParagraph}>
              <PlusIcon className="size-3.5" /> 添加段落（Ctrl+Enter）
            </Button>
          )}
          {!noMedia &&
            (compact ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                title={mediaLabel}
                aria-label={mediaLabel}
                onClick={() => setMediaOpen(true)}
              >
                <ImagePlusIcon className="size-3.5" />
              </Button>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setMediaOpen(true)}>
                <ImagePlusIcon className="size-3.5" /> {mediaLabel}
              </Button>
            ))}
        </div>
      )}
      {!noMedia && (
        <MediaUploaderDialog
          purpose="question_media"
          open={mediaOpen}
          onOpenChange={setMediaOpen}
          onUploaded={(m) => {
            // 文件块把原始文件名存进 alt，展示端据此显示可读名称
            onChange([
              ...list,
              { t: "media", kind: m.kind, key: m.key, alt: m.kind === "file" ? (m.name ?? "") : "" },
            ])
            setMediaOpen(false)
          }}
        />
      )}
    </div>
  )
}
