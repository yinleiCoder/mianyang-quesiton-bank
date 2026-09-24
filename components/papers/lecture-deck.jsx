"use client"

// 讲评模式（投屏用）：一题一屏，键盘翻页。
//
// 三个刻意的设计：
//   1. **URL 即光标**（`?i=7&reveal=1`）：刷新、投屏断线重连、把「第 12 题」的链接发给同事
//      都成立。但**不用 router.replace** —— 那会触发一次 RSC 请求，按一下右键就打一次库；
//      这里用 history.replaceState 只改地址栏。代价：刷新后 useSearchParams 是旧值，
//      所以初值只在挂载时从服务端 props 取一次。
//   2. **答案默认不露出**（reveal=false）：投影时先让学生自己想，按 `a` 才亮出来。
//   3. 开场第 0 屏给成绩分布，老师切过去就能说"这次班均 62，最高 100 是张伟"。
//
// 题干用 QuestionView（与打印卷、阅卷台同一个渲染器）：卷面上长什么样，投出来就什么样。

import { useCallback, useEffect, useState } from "react"
import { QuestionView } from "@/components/questions/question-view"
import { qtypeLabel } from "@/lib/question-model"
import { percentText } from "@/lib/analytics"
import { Button } from "@/components/ui/button"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  EyeIcon,
  EyeOffIcon,
  MaximizeIcon,
} from "lucide-react"

export function LectureDeck({ paper, slides, board, initialIndex, initialReveal }) {
  const total = slides.length
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), total))
  const [reveal, setReveal] = useState(initialReveal)

  // 只改地址栏，不打服务端（见文件头第 1 条）
  const syncUrl = useCallback(
    (i, r) => {
      const qs = new URLSearchParams({ i: String(i) })
      if (r) qs.set("reveal", "1")
      window.history.replaceState(null, "", `${window.location.pathname}?${qs}`)
    },
    []
  )

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
        if (document.fullscreenElement) document.exitFullscreen?.()
        else document.documentElement.requestFullscreen?.()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [goTo, index, toggleReveal, total])

  const slide = index === 0 ? null : slides[index - 1]

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-50">
      {/* 顶部细条：位置 + 操作。鼠标也得能用——只有键盘的话讲不了课 */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-2">
        <span className="truncate text-sm font-medium">{paper.title}</span>
        <span className="text-xs text-slate-400">
          {index === 0 ? "开场" : `第 ${index} / ${total} 题`}
        </span>
        <div className="ml-auto flex items-center gap-2">
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
          <Button
            size="sm"
            variant="outline"
            onClick={() => document.documentElement.requestFullscreen?.()}
          >
            <MaximizeIcon className="size-4" /> 全屏
          </Button>
          {/* 整卷速览复用打印路由：卷面排版那边已经做好了，不必再实现一遍 */}
          <a
            href={`/print/paper/${paper.versionId}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-sm hover:bg-slate-800"
          >
            整卷速览 ↗
          </a>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        {slide ? (
          <QuestionSlide slide={slide} reveal={reveal} />
        ) : (
          <OpeningSlide paper={paper} board={board} onStart={() => goTo(1)} />
        )}
      </main>

      <footer className="border-t border-slate-800 px-4 py-1.5 text-center text-xs text-slate-500">
        ← → 翻屏 · A 显示/收起答案 · F 全屏 · Home/End 首末
      </footer>
    </div>
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
        <p className="mt-1 text-slate-400">
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
        <p className="mb-2 text-sm text-slate-400">成绩分布（按得分率分 10 档）</p>
        <div className="flex h-48 items-end gap-2">
          {buckets.map((b) => (
            <div key={b.from} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-xs tabular-nums text-slate-400">{b.count || ""}</span>
              <div
                className="w-full rounded-t bg-sky-500/70"
                style={{ height: `${Math.max(2, Math.round((b.count / maxCount) * 100))}%` }}
              />
              <span className="text-xs tabular-nums text-slate-500">{b.from}%</span>
            </div>
          ))}
        </div>
      </div>

      {top3.length > 0 && (
        <div>
          <p className="mb-2 text-sm text-slate-400">前三名</p>
          <div className="flex flex-wrap gap-4">
            {top3.map((r, i) => (
              <div key={r.user_id} className="rounded-xl border border-slate-700 px-5 py-3">
                <p className="text-lg">
                  {["🥇", "🥈", "🥉"][i]} {r.name}
                </p>
                <p className="text-sm text-slate-400 tabular-nums">
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
    <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section className="rounded-xl bg-white p-6 text-slate-900">
        <div className="mb-3 flex items-center gap-2 border-b pb-2">
          <span className="text-lg font-semibold tabular-nums">第 {slide.seq} 题</span>
          <span className="text-sm text-slate-500">
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
        <div className="rounded-xl border border-slate-700 p-4">
          <p className="text-sm text-slate-400">正确率</p>
          <p
            className={`text-5xl font-semibold tabular-nums ${
              rate == null ? "text-slate-400" : rate <= 0.4 ? "text-rose-400" : "text-emerald-400"
            }`}
          >
            {/* 还没有判分的作答时显示「—」而不是 0% */}
            {rate == null ? "—" : percentText(rate)}
          </p>
          <p className="mt-1 text-sm text-slate-400 tabular-nums">
            {stat.correct ?? 0} / {stat.graded ?? 0} 人答对
            {Number(stat.blank) > 0 && ` · ${stat.blank} 人未答`}
            {Number(stat.pending) > 0 && ` · ${stat.pending} 人待阅卷`}
          </p>
        </div>

        {options.length > 0 && (
          <div className="space-y-2 rounded-xl border border-slate-700 p-4">
            <p className="text-sm text-slate-400">选项分布</p>
            {options.map((o) => {
              const count = Number(o.count) || 0
              const ratio = total > 0 ? count / total : 0
              const names = (o.students ?? []).map((s) => s.name).filter(Boolean)
              return (
                <div key={o.key} className="space-y-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span
                      className={`inline-flex size-6 shrink-0 items-center justify-center rounded ${
                        o.is_answer ? "bg-emerald-500 text-white" : "bg-slate-700 text-slate-300"
                      }`}
                    >
                      {o.key}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{o.text}</span>
                    <span className="shrink-0 tabular-nums text-slate-300">
                      {count} 人 · {percentText(ratio)}
                    </span>
                  </div>
                  <div className="ml-8 h-2 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className={`h-full rounded-full ${o.is_answer ? "bg-emerald-500" : "bg-slate-500"}`}
                      style={{ width: `${Math.round(ratio * 100)}%` }}
                    />
                  </div>
                  {names.length > 0 && (
                    <p className="ml-8 text-xs text-slate-400">
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
          <div className="rounded-xl border border-slate-700 p-4">
            <p className="text-sm text-slate-400">答错的 {stat.wrong_total} 人</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {wrongs.map((s) => (
                <span key={s.user_id} className="rounded-full bg-slate-800 px-2 py-0.5 text-xs">
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
    <div className="rounded-xl border border-slate-700 px-4 py-3">
      <p className="text-sm text-slate-400">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
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
