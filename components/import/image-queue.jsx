"use client"

// 图片队列：一次导入多张照片时的「看得见的顺序」。
//
// 为什么非要有这个东西：图片是**按顺序**变成第 1、2、3… 页的，而页号是解析结果、
// 跨页拼接、重试与续跑的唯一锚点。以前只有一个多选文件框——选完就看不见选了什么、
// 什么顺序、能不能补一张，于是「多图」这个能力实际上没人敢用。
//
// ⚠ 顺序只在**建任务之前**可改。任务一旦建好，页号就写进库了；这时再删/挪一张，
// 第 7 页就会静默换成另一张照片。所以跑批页的重选一律 editable={false}。

import { useEffect, useMemo, useRef } from "react"
import { Button } from "@/components/ui/button"
import { ImagePlusIcon, ArrowUpIcon, ArrowDownIcon, XIcon } from "lucide-react"

export function ImageQueue({ files = [], onChange, disabled, editable = true, hint }) {
  const inputRef = useRef(null)

  // 缩略图用 object URL；列表变化时整批重建，上一批在 cleanup 里释放
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls])

  const add = (list) => {
    const picked = Array.from(list ?? [])
    if (picked.length === 0) return
    onChange?.([...files, ...picked])
    // 同一个 input 连续选同一批文件时 change 不会再触发，清空它的值
    if (inputRef.current) inputRef.current.value = ""
  }

  const remove = (index) => onChange?.(files.filter((_, i) => i !== index))
  const move = (index, delta) => {
    const to = index + delta
    if (to < 0 || to >= files.length) return
    const next = [...files]
    ;[next[index], next[to]] = [next[to], next[index]]
    onChange?.(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlusIcon className="size-4" />
          添加图片
        </Button>
        <span className="text-xs text-muted-foreground">
          {files.length > 0
            ? `共 ${files.length} 张 · 按顺序变成第 1~${files.length} 页`
            : "可一次选多张；顺序 = 页序"}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          disabled={!editable || disabled}
          onChange={(e) => add(e.target.files)}
        />
      </div>

      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((file, i) => (
            <li
              key={`${file.name}-${file.size}-${file.lastModified}-${i}`}
              className="group relative w-20 overflow-hidden rounded-lg border bg-muted"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={urls[i]} alt={file.name} className="h-24 w-20 object-cover" />
              <span className="absolute left-0 top-0 rounded-br bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white">
                第 {i + 1} 页
              </span>
              {editable && (
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-black/55 p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    title="前移一位"
                    disabled={i === 0 || disabled}
                    onClick={() => move(i, -1)}
                    className="rounded p-1 text-white/90 hover:bg-white/20 disabled:opacity-30"
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="后移一位"
                    disabled={i === files.length - 1 || disabled}
                    onClick={() => move(i, 1)}
                    className="rounded p-1 text-white/90 hover:bg-white/20 disabled:opacity-30"
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="移除"
                    disabled={disabled}
                    onClick={() => remove(i)}
                    className="rounded p-1 text-white/90 hover:bg-rose-500/60 disabled:opacity-30"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
