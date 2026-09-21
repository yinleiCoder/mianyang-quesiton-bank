"use client"

// 资料卡片。网页端给教师用（管理与预览），学生消费在 Flutter 端。
//
// 「上传人 + 学校 + 下载次数」是用户明确要求的：**以此尊重教师的付出**，
// 所以这三项在卡片上占的位置不比标题小——不要为了紧凑把它们塞进 tooltip。
import { objectUrl } from "@/lib/oss-url"
import { nodePathOf } from "@/lib/subject-nodes"
import { kindLabel, opensInline } from "@/lib/materials"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  FileSpreadsheetIcon,
  FileTextIcon,
  FileIcon,
  HeadphonesIcon,
  ImageIcon,
  PresentationIcon,
  VideoIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  EyeIcon,
  Trash2Icon,
} from "lucide-react"

const ICONS = {
  pdf: FileTextIcon,
  word: FileTextIcon,
  sheet: FileSpreadsheetIcon,
  slide: PresentationIcon,
  image: ImageIcon,
  audio: HeadphonesIcon,
  video: VideoIcon,
  other: FileIcon,
}

function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function humanDate(value) {
  if (!value) return ""
  const d = new Date(value)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function MaterialCard({ material, nodes, canManage, onDelete, onTogglePublish }) {
  const Icon = ICONS[material.kind] ?? FileIcon
  const href = objectUrl(material.object_key)

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate font-medium">{material.title}</h3>
            {!material.is_published && <Badge variant="secondary">已下架</Badge>}
          </div>
          {material.description && (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{material.description}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <Badge variant="outline">{kindLabel(material.kind)}</Badge>
        {material.course_node_id && <span>{nodePathOf(nodes, material.course_node_id)}</span>}
        <span>{humanSize(material.size)}</span>
        <span>{humanDate(material.created_at)}</span>
        {!opensInline(material.kind) && <span>· 需用系统程序打开</span>}
      </div>

      {/* 署名与下载次数：用户明确要求「标注上传人是谁、所处的学校、下载次数」 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
        <span className="text-muted-foreground">
          {material.creator_name ?? "上传人已注销"}
          {material.school_name ? ` · ${material.school_name}` : ""}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <DownloadIcon className="size-3.5" />
          下载 {material.download_count} 次
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          render={<a href={href} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon className="size-4" /> 打开
        </Button>
        {canManage && (
          <>
            <Button variant="ghost" size="sm" onClick={() => onTogglePublish(material)}>
              {material.is_published ? (
                <>
                  <EyeOffIcon className="size-4" /> 下架
                </>
              ) : (
                <>
                  <EyeIcon className="size-4" /> 上架
                </>
              )}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onDelete(material)}>
              <Trash2Icon className="size-4" /> 删除
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
