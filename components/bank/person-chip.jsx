"use client"

// 人员 chip：头像 + 姓名（可带角色前缀），点击在光标附近弹出个人资料浮层。
// person 为 null 时渲染灰色"已注销"占位（无交互）；浮层信息来自服务端下发的快照，不再发请求。
import * as React from "react"
import { createPortal } from "react-dom"
import { avatarUrl } from "@/lib/oss-url"
import { Building2Icon, MailIcon } from "lucide-react"
import { cn } from "cn"

const initialOf = (name) => ((name || "?").trim().charAt(0) || "?").toUpperCase()

// 迷你圆形头像：有 url 显示图片（加载失败自动回落），否则显示姓名首字
function Face({ url, name, className }) {
  const [err, setErr] = React.useState(false)
  const showImg = Boolean(url) && !err
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground select-none",
        className
      )}
    >
      {showImg && (
        <img
          src={url}
          alt=""
          className="absolute inset-0 size-full object-cover"
          onError={() => setErr(true)}
        />
      )}
      <span className="relative leading-none">{initialOf(name)}</span>
    </span>
  )
}

export function PersonChip({ person, caption, className }) {
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState(null)
  const btnRef = React.useRef(null)

  const close = React.useCallback(() => {
    setOpen(false)
  }, [])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === "Escape") close()
    }
    const onDown = (e) => {
      if (btnRef.current && !btnRef.current.contains(e.target)) close()
    }
    const onScrollOrResize = () => close()
    document.addEventListener("keydown", onKey, true)
    document.addEventListener("pointerdown", onDown, true)
    window.addEventListener("scroll", onScrollOrResize, true)
    window.addEventListener("resize", onScrollOrResize)
    return () => {
      document.removeEventListener("keydown", onKey, true)
      document.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("scroll", onScrollOrResize, true)
      window.removeEventListener("resize", onScrollOrResize)
    }
  }, [open, close])

  // 作者/审核人已注销（person=null）：无资料可弹
  if (!person) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground/70", className)}>
        {caption && <span className="text-muted-foreground/60">{caption}</span>}
        <span>已注销</span>
      </span>
    )
  }

  function openAt(e) {
    e.preventDefault()
    e.stopPropagation()
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const W = 280
    const left = Math.max(8, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - 8))
    const estH = 176
    const below = r.bottom + 6 + estH < window.innerHeight
    const top = below ? r.bottom + 6 : Math.max(8, r.top - estH - 6)
    setPos({ left, top })
    setOpen(true)
  }

  const imgUrl = person.avatarKey ? avatarUrl(person.avatarKey) : ""
  const title = `${person.name}（${person.roles.join(" · ")}）`

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={openAt}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-full border border-transparent py-0.5 pr-2 pl-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          open && "border-border bg-accent/70",
          className
        )}
      >
        <Face url={imgUrl} name={person.name} className="size-5 text-[10px]" />
        {caption && <span className="shrink-0 text-muted-foreground/70">{caption}</span>}
        <span className="truncate text-foreground/90">{person.name}</span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            role="dialog"
            aria-label={`${person.name} 的个人资料`}
            className="fixed z-50 w-[280px] rounded-xl border bg-popover p-3 shadow-md ring-1 ring-foreground/10"
            style={{ left: pos.left, top: pos.top }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-2.5">
              <Face url={imgUrl} name={person.name} className="size-11 text-base" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate text-sm font-medium">{person.name}</p>
                <p className="text-xs text-muted-foreground">{person.roles.join(" · ")}</p>
              </div>
            </div>
            <div className="mt-2.5 space-y-1.5 border-t pt-2 text-xs text-muted-foreground">
              {person.schoolName && (
                <p className="flex items-center gap-1.5">
                  <Building2Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{person.schoolName}</span>
                </p>
              )}
              {person.email && (
                <p className="flex items-center gap-1.5">
                  <MailIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{person.email}</span>
                </p>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
