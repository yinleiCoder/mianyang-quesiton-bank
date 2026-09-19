"use client"

// 跑批控制台：认领页 → 本地渲染素材 → 用使用者自己的密钥直连 DeepSeek → 回写 → 下一批。
//
// 三条硬约束（都有前车之鉴，改动前先读完）：
//   1. **循环用 ref 不用 state**：dev 下 React 的 StrictMode 会让 effect 跑两次，
//      用 state 触发会双倍认领、双倍花钱。库里还有租约兜底，但别指望它。
//   2. **进度权威在数据库**：这里只做展示，刷新/关页面都不丢——重新打开任务页，
//      已完成的页不会被重跑（认领条件排除了它们）。
//   3. 页面素材只在需要时渲染：一页 6 张切片约 1.2MB，一次拿太多会把内存吃满。

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { PAGE_STATES, pageStateChip } from "@/lib/import-jobs"
import { Button } from "@/components/ui/button"
import { buildPagePayload } from "@/components/import/import-wizard"
import { parseAndSavePages, MissingKeyError } from "@/lib/import-parse-client"
import { DeepSeekSettingsPanel } from "@/components/import/deepseek-settings-panel"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { PlayIcon, PauseIcon, RotateCcwIcon, AlertTriangleIcon } from "lucide-react"

// 解析节奏：**只有一条车道**，不再提供"多车道并发"档位。
//
// 为什么删掉多车道：车道数 = 同时进行的 import_save_page 调用数，而这些调用写的是**同一个 job**
// —— 每存一页 import_refresh_job 都要 update import_jobs 的同一行、并把该任务的页/题全量重算一遍，
// 所以它们天生互相排队。排队一旦超过 deadlock_timeout（1s），log_lock_waits=on 就会把
// **整条 SQL 原文**写进 Postgres 日志（那条 INSERT ... from jsonb_array_elements 很长）。
// 小规格实例的盘被这些日志写满之后，PostgREST 拿不到连接，站点开始成片报 connection pool timeout。
// 换句话说"快 3 倍"的代价不是多花点 CPU，而是把整个实例拖垮 —— 这不是一个该摆给使用者的选项。
//
// 那速度从哪来？**把并发放在模型调用上，而不是放在写库上。**
// parseAndSavePages 内部本来就是「本批各页并发调 DeepSeek（纯网络，不碰库）→ 再逐页串行写库」，
// 所以只要把「一次认领几页」调大，就同时得到：并发的模型调用 + 唯一的写库通道。
// 模型等待是这条流水线的大头（本地渲染之外就是它），并行掉它就够了。
const PER_CLAIM = 3

// ---------- 跑飞闸门（**改动前先读完**）----------
// 2026-09-19 的事故：客户端存库一直失败、又一直重试，13 小时打了 6,600 万次请求，
// 把实例 CPU 打满、日志管道打到丢包 99.9%（连排查都没法做，只能靠数据库计数器定位）。
// 教训是：**数据库的租约只能保证"不重复入库"，拦不住客户端空转** —— 闸必须设在客户端，
// 而且要设得笨一点：不去猜"什么情况下会空转"，只数「这一轮有没有一页真正存进库」，
// 连着几轮都没有就停手并说明原因。
const MAX_ROUNDS = 200 // 单次「继续解析」最多认领这么多轮（一轮最多 PER_CLAIM 页；与服务端每小时 600 页上限对齐）
const MAX_IDLE_ROUNDS = 8 // 连续这么多轮一页都没落库 → 停下（正常一轮至少能存进一页）
const MIN_ROUND_GAP_MS = 1000 // 两轮之间至少隔一秒：正常一轮要跑模型（十几秒），这行只为拦住"瞬间空转"

// ---------- 单标签页运行锁 ----------
// 为什么需要：两个标签页同时跑同一个任务时，库里的租约会让其中一方**解析完却存不进去**
// （40001「该页已被其他标签页处理」）。两边都花了模型的钱，失败那侧还会不停重试，
// 每次抛错都往 Postgres 日志里写一条 error——实测半秒能写 6 条，是日志暴涨的触发源之一。
// 这不是"安全"问题（租约已经保证了不重复入库），是**白花钱 + 刷日志**的问题。
//
// 用 localStorage + 心跳：看到别人 8 秒内的心跳就**提醒**（不硬拦）。
//
// 为什么不硬拦：这个锁只防"白花钱"，不防"数据出错"——数据库的租约已经保证同一页不会被
// 重复入库。而硬拦的代价很实在：刷新页面后旧实例的标记还在有效期内，使用者会被自己
// 上一秒的页面挡住，只能干等（踩过一次）。所以改成：提示 + 给一个「仍要继续」的入口。
// 拿不到锁也放行（隐私模式下 localStorage 不可用），租约仍是最终防线。
const RUN_LOCK_TTL = 8000
const TAB_ID = Math.random().toString(36).slice(2)
const lockKey = (jobId) => `mianyang.import.running.${jobId}`

function acquireRunLock(jobId) {
  try {
    const raw = localStorage.getItem(lockKey(jobId))
    const cur = raw ? JSON.parse(raw) : null
    if (cur && cur.tab !== TAB_ID && Date.now() - cur.at < RUN_LOCK_TTL) return false
    localStorage.setItem(lockKey(jobId), JSON.stringify({ tab: TAB_ID, at: Date.now() }))
    return true
  } catch {
    return true // 读不到存储就别拦人，交给库里的租约兜底
  }
}

function releaseRunLock(jobId) {
  try {
    const raw = localStorage.getItem(lockKey(jobId))
    if (raw && JSON.parse(raw)?.tab === TAB_ID) localStorage.removeItem(lockKey(jobId))
  } catch {
    // 忽略
  }
}

export function ImportRun({ job, pages, fileRef, onProgressPatch, onProgress, onFinished, onRePick }) {
  const [running, setRunning] = useState(false)
  const [laneState, setLaneState] = useState({})
  // 最近一页的耗时拆解：素材（浏览器渲染+编码）与请求（上传+模型+落库）分开计时。
  // 没有这个就只能靠猜——而"慢"的成因完全可能是本地上行带宽而不是模型。
  const [timing, setTiming] = useState(null)
  const [error, setError] = useState(null)
  const stopRef = useRef(false)
  const startedRef = useRef(false)

  // 密钥在 localStorage 里，SSR 读不到：用 hook 在挂载后读，避免 hydration 不一致
  const { hasKey, ready: keyReady, refresh: refreshKey } = useDeepSeekPrefs()
  const hasFile = Boolean(fileRef.current)
  const remaining = pages.filter(
    (p) => p.attempts < 3 && (p.status === "pending" || p.status === "running")
  ).length

  useEffect(() => {
    // 卸载时让循环退出。在途的那一批会自然跑完并落库——这比强行中断更好：
    // 中断会让已花的钱白费，而结果落库后页面上是"已完成"。
    const release = () => releaseRunLock(job.id)
    // 刷新/关页面时主动交还运行标记：否则残留的标记会把自己挡 8 秒
    window.addEventListener("pagehide", release)
    return () => {
      stopRef.current = true
      window.removeEventListener("pagehide", release)
      release()
    }
  }, [job.id])

  async function runLane(laneId) {
    const supabase = createClient()
    const handle = fileRef.current
    let rounds = 0
    let idleRounds = 0
    for (;;) {
      if (stopRef.current) return
      // 闸门一：轮数上限。到了就停，断点都在库里，点「继续解析」接着跑
      if (rounds >= MAX_ROUNDS) {
        setError(`一次最多连续解析 ${MAX_ROUNDS} 轮（约 ${MAX_ROUNDS * PER_CLAIM} 页），已停下。点「继续解析」可以从断点接着跑。`)
        stopRef.current = true
        return
      }
      // 闸门二：连着好几轮一页都没落库 —— 这时候再跑下去只是空转（这次的 6,600 万次请求就是这么来的）
      if (idleRounds >= MAX_IDLE_ROUNDS) {
        setError(
          `连续 ${MAX_IDLE_ROUNDS} 轮都没有一页成功存进数据库，已停下（避免空转和重复花钱）。` +
            `常见原因是数据库连接拥塞或上游限流；过几分钟点「继续解析」再试。`
        )
        stopRef.current = true
        return
      }
      rounds += 1
      setLaneState((s) => ({ ...s, [laneId]: "认领中" }))
      const { data: claimed, error: claimErr } = await supabase.rpc("import_claim_pages", {
        p_job_id: job.id,
        // 一次认领一批 = 本批的模型并发度；写库仍是一条串行通道（见文件头 PER_CLAIM 的说明）
        p_limit: PER_CLAIM,
        p_lease_seconds: 300,
      })
      if (claimErr) {
        setError(claimErr.message)
        toast.error(claimErr.message)
        return
      }
      if (!claimed || claimed.length === 0) {
        setLaneState((s) => ({ ...s, [laneId]: "空闲" }))
        return
      }
      // 认领的页行直接并进本地状态：这一批的"待解析 → 解析中"立刻可见，无需查库
      onProgressPatch?.({ pages: claimed })

      let savedThisRound = 0
      try {
        // 本地渲染：这一步最耗 CPU，也是"源文件不上传"的代价所在
        const t0 = Date.now()
        setLaneState((s) => ({ ...s, [laneId]: `渲染第 ${claimed.map((p) => p.page_no).join("/")} 页` }))
        const payloads = []
        let prevTail = null
        for (const p of claimed) {
          const payload = await buildPagePayload(handle, p.page_no, "auto", "high")
          if (prevTail && payload.text) payload.prev_tail = prevTail
          if (payload.text) prevTail = payload.text.slice(-200)
          if (payload.images?.length > 8) payload.images = payload.images.slice(0, 8)
          // **租约是每页一份，不是一批一份**：import_claim_pages 逐行
          // gen_random_uuid()，同一批认领回来的三页 token 各不相同。贴在素材上
          // 而不是另外传一个"本批的 token"——token 与它那一页绑死，配错就不可能发生。
          // （2026-09-18 起的写法是给整批用 claimed[0].lease_token：同批只有那一页
          //   存得进去，另外两页被服务端判成「已被其他标签页处理」，白调模型还丢结果。）
          payload.lease_token = p.lease_token
          payloads.push(payload)
        }

        const tReady = Date.now()
        const bytes = payloads.reduce(
          (n, x) => n + (x.images ?? []).reduce((m, i) => m + i.data_url.length, 0),
          0
        )
        setLaneState((s) => ({ ...s, [laneId]: `解析第 ${claimed.map((p) => p.page_no).join("/")} 页` }))
        const res = await parseAndSavePages({
          jobId: job.id,
          // 租约跟着每页的素材走（见上面 payload.lease_token），这里不再传"本批的 token"
          pages: payloads,
          opts: {
            genAnalysis: job.gen_analysis,
            defaultQtype: job.default_qtype,
            defaultDifficulty: job.default_difficulty,
            // 整卷还原：提示词换成 PAPER_TAIL，并让 normalizePage 额外抽卷头/大题/分值
            paperMode: job.mode === "paper",
          },
          // 每页落库就把服务端回传的进度并进本地状态（不查库）——先跑完的那页立刻变绿
          onPageSaved: (saved) =>
            onProgressPatch?.({ pages: saved?.page ? [saved.page] : [], job: saved?.job }),
        })
        const tDone = Date.now()
        setTiming({
          page: claimed.map((p) => p.page_no).join("/"),
          mode: payloads[0]?.mode ?? "-",
          prepareMs: tReady - t0,
          requestMs: tDone - tReady,
          uploadKB: Math.round(bytes / 1024),
        })
        // 整批都没存进去 = 这页已经被别的标签页/另一台机器接手了。
        // 继续跑只会重复调模型花钱，所以直接停下并说明原因（库里的租约不会被破坏，
        // 对方仍会把结果存好）。
        const saves = res?.saves ?? []
        savedThisRound = saves.filter((s) => s.saved).length
        if (saves.length > 0 && saves.every((s) => s.conflict)) {
          setError("这个任务正被另一个标签页（或另一台设备）处理，本页面已停止，避免重复消耗解析额度。")
          stopRef.current = true
          return
        }
        // 模型的钱已经花了，结果却没进库（多是数据库连接池拥塞：实测一次 504 要等 125 秒）。
        // **必须说出来**——以前这里是静默的：那几页永远停在"解析中"，用户只看到"跑着跑着不动了"，
        // 既不知道发生了什么，也不知道那一页的钱已经白花了。
        const unsaved = saves.filter((s) => !s.saved && !s.conflict)
        if (unsaved.length > 0) {
          setError(
            `第 ${unsaved.map((s) => s.page_no).join("、")} 页的解析结果没能存进数据库` +
              `（${unsaved[0].error ?? "未知原因"}）。这几页要重新解析——` +
              `等 5 分钟让租约过期后点「继续解析」即可（重跑会再花一次模型的钱）。`
          )
        }
        // 有页失败（多为上游限流/抽风）时歇一下再继续：服务端会把可重试的失败放回 pending，
        // 不 backoff 就会立刻重新认领同一页，把限流打得更死
        const failed = (res?.results ?? []).filter((r) => !r.ok).length
        if (failed > 0) {
          setLaneState((s) => ({ ...s, [laneId]: `${failed} 页失败，稍后自动重试` }))
          await sleep(3000 + Math.floor(Math.random() * 2000))
        }
      } catch (err) {
        if (err?.name === "AbortError") return
        if (err instanceof MissingKeyError) {
          // 密钥被清掉了（另一个标签页清除、或换了浏览器）：停下并引导去配置。
          // refreshKey 会重新读一次，读到空就把面板放出来
          refreshKey()
          setError(err.message)
          return
        }
        setError(err?.message ?? "解析失败")
        await sleep(2000)
      }

      // 这一轮有没有一页真正落库？没有就记一次 idle（连着几轮都没有 → 上面那道闸会停手）。
      // 结尾这一秒是**闸门三**：正常一轮要跑模型（十几秒），它只为拦住"瞬间空转"的循环。
      idleRounds = savedThisRound > 0 ? 0 : idleRounds + 1
      await sleep(MIN_ROUND_GAP_MS)
    }
  }

  async function start(force) {
    const forced = force === true // 只认显式 true：onClick 会把事件对象传进来，别让它绕过锁
    if (startedRef.current || !hasFile || running) return
    // 另一个标签页在跑时只提醒、不硬拦：数据库的租约保证不会重复入库，
    // 这里要防的只是"两边都调模型、都花钱"。刷新页面后旧标记仍在有效期内是常见情况，
    // 硬拦会把人挡在门外（而且是自己挡自己），所以给一个明确的"仍要继续"。
    if (!forced && !acquireRunLock(job.id)) {
      toast.warning("检测到另一个标签页可能正在解析这个任务。两边同时跑会重复调用模型、重复付费。", {
        duration: 10000,
        action: { label: "仍要继续", onClick: () => start(true) },
      })
      return
    }
    startedRef.current = true
    stopRef.current = false
    setRunning(true)
    setError(null)
    // 心跳：让其他标签页知道这里在跑（15 秒没心跳就视为已停止）
    const beat = setInterval(() => acquireRunLock(job.id), 5000)
    try {
      // 单车道：并发已经在 runLane 内部（一批多页并发调模型），这里再并发就会变成并发写库
      await runLane(0)
    } finally {
      clearInterval(beat)
      releaseRunLock(job.id)
      setRunning(false)
      startedRef.current = false
      // 收尾拉一次完整的（含题列表）——中途每页只刷轻量的那部分
      await onFinished?.()
    }
  }

  function stop() {
    // 只是"不再认领新页"：正在解析的那一批会跑完并落库（花掉的钱不该白费）
    stopRef.current = true
    setRunning(false)
  }

  async function retryFailed() {
    const supabase = createClient()
    const { data, error: err } = await supabase.rpc("import_retry_pages", { p_job_id: job.id })
    if (err) return toast.error(err.message)
    toast.success(`已把 ${data ?? 0} 页重新排队`)
    await onProgress()
  }

  async function skipPage(pageNo) {
    const supabase = createClient()
    const { error: err } = await supabase.rpc("import_skip_page", { p_job_id: job.id, p_page_no: pageNo })
    if (err) return toast.error(err.message)
    await onProgress()
  }

  return (
    <div className="space-y-4">
      {/* 没配密钥就不能跑：面板内联在跑批台顶部，配好即解锁。
          keyReady 之前不渲染面板（服务端与客户端首帧保持一致，否则会 hydration 失败） */}
      {keyReady && !hasKey && <DeepSeekSettingsPanel onChange={refreshKey} />}

      <div className="flex flex-wrap items-center gap-2">
        {!running ? (
          <Button
            onClick={() => start()}
            disabled={!hasFile || !hasKey || !keyReady}
            title={hasKey ? "" : "需要先配置你自己的 DeepSeek 密钥"}
          >
            <PlayIcon className="size-4" />
            {remaining > 0 ? `继续解析（剩 ${remaining} 页）` : "开始解析"}
          </Button>
        ) : (
          <Button variant="outline" onClick={stop}>
            <PauseIcon className="size-4" />
            暂停
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={retryFailed}>
          <RotateCcwIcon className="size-4" />
          重试失败页
        </Button>
        <span className="text-xs text-muted-foreground">
          已完成 {job.done_pages}/{job.total_pages} 页 · 失败 {job.failed_pages} · 抽到题 {job.item_count}
          {running && ` · ${Object.values(laneState).join(" / ")}`}
        </span>
        {timing && (
          <span className="text-xs text-muted-foreground/80" title="本地准备=浏览器渲染并编码这一页的素材；请求=上传素材给 DeepSeek + 模型生成 + 落库">
            上一页（第 {timing.page} 页 · {timing.mode}）：本地准备 {(timing.prepareMs / 1000).toFixed(1)}s ·
            请求处理 {(timing.requestMs / 1000).toFixed(1)}s · 上传约 {timing.uploadKB} KB
          </span>
        )}
      </div>

      {!hasFile && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangleIcon className="size-4 shrink-0" />
          <span>文件不在内存里了（刷新过页面）。重新选择同一个文件即可从断点继续，已解析的页不会重跑。</span>
          <Button size="sm" variant="outline" onClick={onRePick}>
            重新选择文件
          </Button>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      {/* 解析失败的页把原因直接摆出来（以前只藏在格子的悬停提示里，得挨个去猜） */}
      {pages
        .filter((p) => p.status === "failed" && p.error)
        .slice(0, 3)
        .map((p) => (
          <p key={p.id} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs text-rose-700">
            第 {p.page_no} 页解析失败：{p.error}
          </p>
        ))}

      <div className="rounded-xl border p-3">
        <div className="flex flex-wrap gap-1.5">
          {pages.map((p) => {
            const chip = pageStateChip(p.status)
            return (
              <button
                key={p.id}
                type="button"
                title={
                  p.error ??
                  `${PAGE_STATES[p.status]?.text ?? p.status}${p.attempts ? ` · 已尝试 ${p.attempts} 次` : ""}`
                }
                onClick={() => (p.status === "pending" || p.status === "failed") && skipPage(p.page_no)}
                className={`h-8 min-w-8 rounded-md px-1.5 text-xs font-medium ${chip.cls} ${
                  p.attempts >= 3 && p.status !== "done" ? "ring-1 ring-rose-300" : ""
                }`}
              >
                {p.page_no}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          点某一页可以跳过它（封面、答案页、空白页不值得花钱解析）。解析失败的页会显示红色描边。
        </p>
      </div>
    </div>
  )
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
