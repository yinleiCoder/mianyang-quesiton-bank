"use client"

// 讲评模式（投屏用）：一题一屏，键盘翻页。
//
// 四个刻意的设计：
//   1. **URL 即光标**（`?i=7&reveal=1`）：刷新、投屏断线重连、把「第 12 题」的链接发给同事
//      都成立。但**不用 router.replace** —— 那会触发一次 RSC 请求，按一下右键就打一次库；
//      这里用 history.replaceState 只改地址栏。代价：刷新后 useSearchParams 是旧值，
//      所以初值只在挂载时从服务端 props 取一次。
//   2. **答案默认不露出**（reveal=false）：投影时先让学生自己想，按 `a` 才亮出来。
//   3. **按题号顺序讲**：服务端快照里 items 的顺序不保证等于卷面序号，这里排一次序再上屏；
//      左右键、答题卡、`?i=` 全部指向排好序的位置，三者不会各说各话。
//   4. **答题卡侧栏**按正确率上色：错的人越多越红，对的人越多越绿，深浅表示程度。
//      它是「一眼看出哪题要重点讲」的工具，不是第二套统计数据——数字仍在右侧统计栏。
//
// 主题用全站的 shadcn 变量（浅色）。**不要**再套 `dark`：教师是在教室投影，
// 旧版的深色舞台在亮环境里反而看不清，且与全站其余页面不是一套观感（2026-10-27 改）。
//
// 题干用 QuestionView（与打印卷、阅卷台同一个渲染器）：卷面上长什么样，投出来就什么样。

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { QuestionView } from "@/components/questions/question-view"
import { qtypeLabel } from "@/lib/question-model"
import { percentText } from "@/lib/analytics"
import { isHighError } from "@/lib/accuracy"
import { Button } from "@/components/ui/button"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  EyeIcon,
  EyeOffIcon,
  MaximizeIcon,
  MinimizeIcon,
} from "lucide-react"

// 正确率 → 颜色。色相从红（0%）走到绿（100%），亮度跟着走一点：
// 全错的题最深、全对的题也最深，中间偏浅——这样"深浅"本身也能读出偏离程度。
// 用内联 HSL 而不是 Tailwind 类：这是连续量，分档会让 39% 和 41% 看起来一样。
function rateStyle(rate, graded) {
  if (rate == null || !(Number(graded) > 0)) {
    return { backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }
  }
  const r = Math.min(1, Math.max(0, Number(rate)))
  const hue = 2 + r * 146 // 红 → 绿
  const light = 38 + Math.abs(r - 0.5) * 18 // 越接近两端越深
  return { backgroundColor: `hsl(${hue} 68% ${light}%)`, color: "#fff" }
}

export function LectureDeck({ paper, slides, board, initialIndex, initialReveal }) {
  // 严格按题号顺序：快照里的 items 顺序不等于卷面序号时，"下一题"会跳着走
  const ordered = useMemo(
    () => [...slides].sort((a, b) => Number(a.seq) - Number(b.seq)),
    [slides]
  )
  const total = ordered.length
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), total))
  const [reveal, setReveal] = useState(initialReveal)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const mainRef = useRef(null)
  const railRef = useRef(null)

  // 只改地址栏，不打服务端（见文件头第 1 条）
  const syncUrl = useCallback((i, r) => {
    const qs = new URLSearchParams({ i: String(i) })
    if (r) qs.set("reveal", "1")
    window.history.replaceState(null, "", `${window.location.pathname}?${qs}`)
  }, [])

  const goTo = useCallback(
    (i, r = reveal) => {
      const next = Math.min(Math.max(i, 0), total)
      setIndex(next)
      setReveal(r)
      syncUrl(next, r)
    },
    [reveal, syncUrl, total]
  )

  const toggleReveal = useCallback(() => goTo(index, !reveal), [goTo, index, reveal])

  // 全屏开关：按钮与 F 键共用这一处，**必须先看 document.fullscreenElement**
  // ——旧版按钮永远调 requestFullscreen，进了全屏再点也只会再请求一次，
  // 浏览器直接忽略，看起来就是"退不出去"（2026-10-27 用户报的 bug）。
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen?.()
      else await document.documentElement.requestFullscreen?.()
    } catch {
      // 浏览器拒绝（权限/手势要求）时不弹错，按钮状态由 fullscreenchange 决定
    }
  }, [])

  // 真实全屏状态由浏览器事件驱动：Esc、F11、浏览器自带退出都要让按钮跟着变
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener("fullscreenchange", onChange)
    onChange()
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  useEffect(() => {
    function onKey(e) {
      // 焦点在输入框时不抢键（本页没有输入框，但将来加个搜索就会踩）
      if (e.target?.closest?.("input, textarea, select")) return
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault()
        goTo(index + 1)
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault()
        goTo(index - 1)
      } else if (e.key === "Home") {
        goTo(0)
      } else if (e.key === "End") {
        goTo(total)
      } else if (e.key === "a" || e.key === "A") {
        toggleReveal()
      } else if (e.key === "f" || e.key === "F") {
        toggleFullscreen()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [goTo, index, toggleReveal, total, toggleFullscreen])

  // 翻屏后回到顶部：上一题滚到一半的位置留着，下一题会从中间开始
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
    railRef.current
      ?.querySelector('[data-current="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [index])

  const slide = index === 0 ? null : ordered[index - 1]

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* 顶部细条：位置 + 操作。鼠标也得能用——只有键盘的话讲不了课 */}
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="truncate text-sm font-medium">{paper.title}</span>
        <span className="text-xs text-muted-foreground">
          {index === 0 ? "开场" : `第 ${index} / ${total} 题`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => goTo(index - 1)} disabled={index === 0}>
            <ArrowLeftIcon className="size-4" /> 上一屏
          </Button>
          <Button size="sm" variant="outline" onClick={() => goTo(index + 1)} disabled={index >= total}>
            下一屏 <ArrowRightIcon className="size-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={toggleReveal}>
            {reveal ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            {reveal ? "收起答案" : "显示答案"}
          </Button>
          <Button size="sm" variant="outline" onClick={toggleFullscreen}>
            {isFullscreen ? <MinimizeIcon className="size-4" /> : <MaximizeIcon className="size-4" />}
            {isFullscreen ? "退出全屏" : "全屏"}
          </Button>
          {/* 整卷速览复用打印路由：卷面排版那边已经做好了，不必再实现一遍 */}
          <a
            href={`/print/paper/${paper.versionId}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border px-2.5 py-1.5 text-sm hover:bg-accent"
          >
            整卷速览 ↗
          </a>
        </div>
      </header>

      {/* 内容在舞台里居中（m-auto 而不是 items-center：内容比一屏高的时候，
          居中会让顶部被裁掉，m-auto 不会——这是对着投影仪时最容易踩的一个） */}
      <main className="flex min-h-0 flex-1 gap-4 p-4">
        <div ref={mainRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="m-auto w-full">
            {slide ? (
              <QuestionSlide slide={slide} reveal={reveal} />
            ) : (
              <OpeningSlide paper={paper} board={board} onStart={() => goTo(1)} />
            )}
          </div>
        </div>
        {total > 0 && (
          <AnswerSheet
            railRef={railRef}
            slides={ordered}
            current={index}
            onJump={(i) => goTo(i)}
          />
        )}
      </main>

      <footer className="border-t px-4 py-1.5 text-center text-xs text-muted-foreground">
        ← → 翻屏 · A 显示/收起答案 · F 全屏 · Home/End 首末 · 右侧答题卡可点
      </footer>
    </div>
  )
}

/** 答题卡侧栏：每个题号一块颜色，红=错得多、绿=对得多；点一下直接跳过去。 */
function AnswerSheet({ railRef, slides, current, onJump }) {
  return (
    <aside className="hidden w-44 shrink-0 flex-col rounded-xl border bg-card p-3 md:flex">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm font-medium">答题卡</p>
        <span className="text-xs text-muted-foreground tabular-nums">{slides.length} 题</span>
      </div>
      <div ref={railRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-3 gap-1.5">
          {slides.map((s, i) => {
            const rate = s.stat?.correct_rate
            const graded = s.stat?.graded
            return (
              <button
                key={s.itemId ?? i}
                type="button"
                data-current={current === i + 1}
                aria-current={current === i + 1 ? "true" : undefined}
                onClick={() => onJump(i + 1)}
                title={`第 ${s.seq} 题 · 正确率 ${rate == null ? "—" : percentText(rate)}（${graded ?? 0} 人）`}
                className={`flex h-8 items-center justify-center rounded-md text-sm font-medium tabular-nums transition-[box-shadow,transform] hover:brightness-105 ${
                  current === i + 1
                    ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                    : ""
                }`}
                style={rateStyle(rate, graded)}
              >
                {s.seq}
              </button>
            )
          })}
        </div>
      </div>
      <div className="mt-2 border-t pt-2">
        <div
          className="h-1.5 w-full rounded-full"
          style={{ background: "linear-gradient(90deg, hsl(2 68% 47%), hsl(39 68% 47%), hsl(75 68% 47%), hsl(112 68% 47%), hsl(148 68% 47%))" }}
        />
        <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
          <span>错得多</span>
          <span>对得多</span>
        </div>
      </div>
    </aside>
  )
}

/** 第 0 屏：这次考得怎么样（分布 + 均分 + 前三名）。 */
function OpeningSlide({ paper, board, onStart }) {
  const rows = board?.rows ?? []
  const stats = board?.stats ?? {}
  const buckets = histogram(rows, paper.fullScore)
  const maxCount = Math.max(1, ...buckets.map((b) => b.count))
  const top3 = rows.slice(0, 3)

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">{paper.title}</h1>
        <p className="mt-1 text-muted-foreground">
          {board?.scope?.label} · 上榜 {stats.total ?? 0} 人 · 满分 {paper.fullScore} 分
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <BigStat label="平均分" value={stats.avg_score ?? "—"} />
        <BigStat label="最高分" value={stats.max_score ?? "—"} />
        <BigStat label="最低分" value={stats.min_score ?? "—"} />
        <BigStat
          label="满分率"
          value={stats.avg_percent != null ? percentText(stats.avg_percent) : "—"}
          hint="平均得分率"
        />
      </div>

      <div>
        <p className="mb-2 text-sm text-muted-foreground">成绩分布（按得分率分 10 档）</p>
        <div className="flex h-48 gap-2">
          {buckets.map((b) => (
            // 柱子用百分比高度，所以**必须**有一个高度确定的父级：
            // 外层给 h-full、中间那层 flex-1 才是"绘图区"。原先直接挂在 flex-col 上，
            // 父级高度是 auto → 百分比解析成 0，柱子一根都画不出来（只有数字浮着）。
            <div key={b.from} className="flex h-full flex-1 flex-col items-center">
              <span className="mb-1 text-xs tabular-nums text-muted-foreground">{b.count || ""}</span>
              <div className="flex w-full flex-1 items-end">
                <div
                  className="w-full rounded-t bg-primary/70"
                  style={{ height: `${Math.max(2, Math.round((b.count / maxCount) * 100))}%` }}
                />
              </div>
              <span className="mt-1 text-xs tabular-nums text-muted-foreground/70">{b.from}%</span>
            </div>
          ))}
        </div>
      </div>

      {top3.length > 0 && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">前三名</p>
          <div className="flex flex-wrap gap-4">
            {top3.map((r, i) => (
              <div key={r.user_id} className="rounded-xl border bg-card px-5 py-3">
                <p className="text-lg">
                  {["🥇", "🥈", "🥉"][i]} {r.name}
                </p>
                <p className="text-sm text-muted-foreground tabular-nums">
                  {Number(r.score)} / {Number(r.full_score)} 分 · {r.school_name}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-center">
        <Button onClick={onStart}>开始讲评 →</Button>
      </div>
    </div>
  )
}

/** 一道题一屏：左题面、右统计。 */
function QuestionSlide({ slide, reveal }) {
  const stat = slide.stat ?? {}
  const options = stat.options ?? []
  const wrongs = stat.wrong_students ?? []
  const rate = stat.correct_rate
  const total = options.reduce((n, o) => n + (Number(o.count) || 0), 0)

  return (
    // items-start：题面卡贴着内容高度（默认 stretch 会被右栏拉成一整条白板，
    // 投出来是"一大片白，字只在最上面"）。题面长的时候它自然会长。
    <div className="mx-auto grid max-w-7xl items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section className="rounded-xl border bg-card p-6 text-card-foreground">
        <div className="mb-3 flex items-center gap-2 border-b pb-2">
          <span className="text-lg font-semibold tabular-nums">第 {slide.seq} 题</span>
          <span className="text-sm text-muted-foreground">
            {qtypeLabel(slide.qtype)} · {Number(slide.score)} 分
          </span>
        </div>
        {/* 与打印卷、阅卷台同一个渲染器：卷面长什么样，投出来就什么样 */}
        <QuestionView
          qtype={slide.qtype}
          content={slide.content}
          showAnswer={reveal}
          variant="paper"
        />
      </section>

      <aside className="space-y-5">
        <div className="rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">正确率</p>
            {/* 卷内口径的易错标识：样本取判过分的人数，与「试题分析」页同一条线 */}
            {isHighError(1 - Number(rate), stat.graded) && (
              <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-xs font-medium text-rose-600">
                易错
              </span>
            )}
          </div>
          <p
            className={`text-5xl font-semibold tabular-nums ${
              rate == null ? "text-muted-foreground" : rate <= 0.4 ? "text-rose-600" : "text-emerald-600"
            }`}
          >
            {/* 还没有判分的作答时显示「—」而不是 0% */}
            {rate == null ? "—" : percentText(rate)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground tabular-nums">
            {stat.correct ?? 0} / {stat.graded ?? 0} 人答对
            {Number(stat.wrong_total) > 0 && ` · 错 ${stat.wrong_total} 人次`}
            {Number(stat.blank) > 0 && ` · ${stat.blank} 人未答`}
            {Number(stat.pending) > 0 && ` · ${stat.pending} 人待阅卷`}
          </p>
        </div>

        {options.length > 0 && (
          <div className="space-y-2 rounded-xl border bg-card p-4">
            <p className="text-sm text-muted-foreground">选项分布</p>
            {options.map((o) => {
              const count = Number(o.count) || 0
              const ratio = total > 0 ? count / total : 0
              const names = (o.students ?? []).map((s) => s.name).filter(Boolean)
              return (
                <div key={o.key} className="space-y-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span
                      className={`inline-flex size-6 shrink-0 items-center justify-center rounded ${
                        o.is_answer ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {o.key}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{o.text}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {count} 人 · {percentText(ratio)}
                    </span>
                  </div>
                  <div className="ml-8 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${o.is_answer ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                      style={{ width: `${Math.round(ratio * 100)}%` }}
                    />
                  </div>
                  {names.length > 0 && (
                    <p className="ml-8 text-xs text-muted-foreground">
                      选它的：{names.slice(0, 10).join("、")}
                      {o.students_truncated || names.length > 10 ? ` 等 ${count} 人` : ""}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {wrongs.length > 0 && (
          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm text-muted-foreground">答错的 {stat.wrong_total} 人</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {wrongs.map((s) => (
                <span key={s.user_id} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                  {s.name}
                  {s.label ? `（选了 ${s.label}）` : ""}
                </span>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

function BigStat({ label, value, hint }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground/70">{hint}</p>}
    </div>
  )
}

/** 按得分率分 10 档（而不是按原始分）：满分 6 分还是 150 分，横轴都读得懂。 */
function histogram(rows, fullScore) {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, count: 0 }))
  for (const r of rows ?? []) {
    const full = Number(r.full_score) || Number(fullScore) || 0
    const pct = full > 0 ? Number(r.score) / full : 0
    const i = Math.min(9, Math.max(0, Math.floor(pct * 10)))
    buckets[i].count += 1
  }
  return buckets
}
