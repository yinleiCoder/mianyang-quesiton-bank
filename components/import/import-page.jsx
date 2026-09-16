"use client"

// 批量导入的容器：一个页面里装「新建向导」与「运行/校对工作台」两种形态。
//
// 为什么不做成两个路由：源文件只在内存里（上百兆的 PDF 不上传），一旦路由跳转
// File 对象就没了——向导创建完任务必须原地切到工作台，同一个组件树、同一份内存。
// 重新打开历史任务（?job=xxx）时文件当然已经不在，工作台会提示重新选择同一份文件，
// 已解析的页不会重跑（进度在数据库里）。

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { loadImportJob, loadJobItems, loadJobPages, jobStateChip } from "@/lib/import-jobs"
import { ImportWizard } from "@/components/import/import-wizard"
import { ImportRun } from "@/components/import/import-run"
import { ImportPreview } from "@/components/import/import-preview"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2Icon, FilesIcon, ListChecksIcon, Trash2Icon } from "lucide-react"

export function ImportPage({ nodes, jobs, initial }) {
  const router = useRouter()
  const fileRef = useRef(null) // 文件 handle（不可序列化，只能放 ref）
  const fileInputRef = useRef(null)

  const [job, setJob] = useState(initial?.job ?? null)
  const [pages, setPages] = useState(initial?.pages ?? [])
  const [items, setItems] = useState(initial?.items ?? [])
  const [tab, setTab] = useState("run")
  const [loading, setLoading] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)

  /**
   * **就地合并进度**（跑批期间的主力）：认领页与落库两个 RPC 都会带回新的状态，
   * 直接并进本地 state 即可——不必再查库。这消掉了跑批期间八成以上的数据库请求
   * （那些请求曾压到 PostgREST 的内部连接池，撞出 PGRST003）。
   * 只有收尾、以及用户手动重试/跳过页时才真正去查（见 refresh）。
   */
  const applyProgress = useCallback(({ pages: changed, job: jobPatch } = {}) => {
    if (changed?.length) {
      const byNo = new Map(changed.map((p) => [p.page_no, p]))
      setPages((list) => list.map((p) => (byNo.has(p.page_no) ? { ...p, ...byNo.get(p.page_no) } : p)))
    }
    if (jobPatch) setJob((j) => (j ? { ...j, ...jobPatch } : j))
  }, [])

  // 任务 id 放 ref：刷新函数要能保持稳定的引用（跑批循环会长期持有它），
  // 同时不因 job.id 变化而重建
  const jobIdRef = useRef(null)
  jobIdRef.current = job?.id ?? null
  const refreshingRef = useRef(false)
  const dirtyRef = useRef(false)
  const lastRefreshRef = useRef(0)
  const timerRef = useRef(null)

  // 卸载时把延后的那次刷新取消掉（别对着已卸载的组件 setState）
  useEffect(() => () => clearTimeout(timerRef.current), [])

  /**
   * 真正去查库的那一段（节流与排队在 refresh 里）。单独拆出来是为了让 refresh 能被
   * 定时器延后调用而不必自引用——React Compiler 遇到自引用的记忆化会整个放弃。
   * withItems=false 时只刷任务与页（跑批中够用，题列表跑完再拉，那个查询重得多）。
   */
  const runRefresh = useCallback(async (withItems) => {
    const id = jobIdRef.current
    if (!id) return
    if (refreshingRef.current) {
      dirtyRef.current = true // 正在刷：记一笔，完成后补刷一次，避免丢更新
      return
    }
    lastRefreshRef.current = Date.now()
    refreshingRef.current = true
    try {
      do {
        dirtyRef.current = false
        try {
          const supabase = createClient()
          const [j, p] = await Promise.all([loadImportJob(supabase, id), loadJobPages(supabase, id)])
          if (j) setJob(j)
          setPages(p)
          if (withItems) setItems(await loadJobItems(supabase, id))
        } catch (err) {
          // 刷失败只影响"进度晚一点显示"，不能把页面搞崩；下一轮（或收尾那次）会补上
          console.warn("进度刷新失败（不影响解析）：", err?.message ?? err)
        }
      } while (dirtyRef.current)
    } finally {
      refreshingRef.current = false
    }
  }, [])

  /**
   * 刷新任务/页/题（调用方 await 它来"落库后重新拉数据"）。四条约束（都是踩过的坑）：
   *   1. **合并**：并发发起会让响应乱序返回、旧数据覆盖新数据，所以同时在跑的只允许一次；
   *   2. **节流**：调用密度可能很高，不加节流会持续压 Supabase 的连接池——实测撞到过
   *      PGRST003「Timed out acquiring connection from connection pool」；
   *   3. **节流窗口内排队，不丢**：丢弃会让"写完库就 await 它"的调用方（勾选题目、
   *      编辑器保存、重试失败页）永远等不到新数据——勾选框勾上又弹回去、
   *      保存完内容还是旧的，都是这么来的；
   *   4. **绝不抛出**：它会作为回调被 fire-and-forget 地调用（不 await），一旦抛错就成了
   *      未处理的 rejection，Next 的覆盖层会显示成没头没脑的 [object Object]。
   *      PostgrestError 是普通对象不是 Error，所以必须自己兜住而不是指望错误页。
   */
  const refresh = useCallback(
    (withItems = true) => {
      if (!jobIdRef.current) return
      // 节流：距上次刷新不足 1.2 秒就**推迟**到窗口结束再刷（进度晚一两秒没关系，
      // 连接池被打满影响所有人），但这次请求不能凭空消失。后来的调用覆盖先前的排队
      // （withItems 取最后一次：勾选后的那次要带题列表，不能被轻量的进度刷新顶掉）
      const wait = 1200 - (Date.now() - lastRefreshRef.current)
      if (wait > 0 && !refreshingRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          runRefresh(withItems)
        }, wait)
        return
      }
      return runRefresh(withItems)
    },
    [runRefresh]
  )

  async function openJob(jobId) {
    setLoading(true)
    try {
      const supabase = createClient()
      const [j, p, it] = await Promise.all([
        loadImportJob(supabase, jobId),
        loadJobPages(supabase, jobId),
        loadJobItems(supabase, jobId),
      ])
      if (!j) return toast.error("任务不存在或无权访问")
      setJob(j)
      setPages(p)
      setItems(it)
      setTab("run")
      // 把 job 写进 URL：刷新后还能回到这个任务（文件仍需重选）
      router.replace(`/questions/import?job=${jobId}`)
    } catch (err) {
      // 这个函数由 onClick 直接调用：不兜住的话，一次读取失败就会变成未处理的 rejection，
      // 界面上只留一个读不懂的对象（PostgrestError 不是 Error）
      toast.error(err?.message ?? "打开任务失败")
    } finally {
      setLoading(false)
    }
  }

  // 放弃任务（软删）：任务与已解析的题作为记录保留，已生成的草稿不受影响。
  // 它也会释放"同时最多 2 个未完成任务"的额度，所以是取消误开任务的正常出口。
  async function discardJob() {
    const supabase = createClient()
    const { error } = await supabase.rpc("import_discard_job", { p_job_id: job.id })
    if (error) return toast.error(error.message)
    toast.success("任务已放弃")
    setDiscardOpen(false)
    startNewJob()
  }

  // 回到新建向导。**必须显式清状态**：只 router.replace 到同一路由的话，
  // Next 只重渲染服务端部分，客户端组件实例不重挂载，job 这个 state 会一直留着旧值——
  // 表现就是"点了没反应"。
  function startNewJob() {
    fileRef.current = null
    setJob(null)
    setPages([])
    setItems([])
    setTab("run")
    router.replace("/questions/import")
  }

  // 重新选同一个文件：只做校验与挂载，不重跑已完成的页
  async function rePick(files) {
    const file = files?.[0]
    if (!file || !job) return
    if (file.name !== job.source_name) {
      const ok = window.confirm(
        `这次选的是「${file.name}」，任务记录的是「${job.source_name}」。\n页号可能对不上，仍要继续吗？`
      )
      if (!ok) return
    }
    try {
      if (job.source_kind === "pdf") {
        const { openPdf } = await import("@/lib/pdf-client")
        fileRef.current = { kind: "pdf", name: file.name, handle: await openPdf(file), files: [file] }
      } else if (job.source_kind === "docx") {
        const { extractDocx } = await import("@/lib/docx-client")
        fileRef.current = { kind: "docx", name: file.name, doc: await extractDocx(file), files: [file] }
      } else {
        const { readImage } = await import("@/components/import/import-wizard")
        fileRef.current = { kind: "image", name: file.name, files: [file], images: [await readImage(file)] }
      }
      toast.success("文件已就绪，可以继续解析")
      setPages((p) => [...p]) // 触发一次重渲染，让"需要重选文件"的提示消失
    } catch (err) {
      toast.error(err?.message ?? "文件读取失败")
    }
  }

  if (!job) {
    return (
      <ImportWizard nodes={nodes} jobs={jobs} fileRef={fileRef} onCreated={openJob} onResume={openJob} />
    )
  }

  const chip = jobStateChip(job.status)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTab("run")}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ${
            tab === "run" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          }`}
        >
          <FilesIcon className="size-3.5" />
          解析进度
        </button>
        <button
          type="button"
          onClick={() => setTab("preview")}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ${
            tab === "preview" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          }`}
        >
          <ListChecksIcon className="size-3.5" />
          校对入库
          <span className="opacity-70">{items.length}</span>
        </button>
        <Badge className={chip.cls}>{chip.text}</Badge>
        {job.last_error && <span className="text-xs text-rose-600">{job.last_error}</span>}
        <span className="ml-auto flex items-center gap-2">
          {loading && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
          <Button variant="outline" size="sm" onClick={startNewJob}>
            新建另一个任务
          </Button>
          {job.status !== "discarded" && (
            <Button variant="ghost" size="sm" onClick={() => setDiscardOpen(true)} title="放弃这个任务">
              <Trash2Icon className="size-3.5" />
              放弃任务
            </Button>
          )}
        </span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => rePick(e.target.files)}
      />

      {/* 条件挂载（ConfirmDialog 的约定：不要常挂载再传 open） */}
      {discardOpen && (
        <ConfirmDialog
          title={`放弃「${job.title}」？`}
          description={
            `任务会标记为「已放弃」并释放一个并发额度；已经生成的 ${job.imported_count} 份草稿不受影响，` +
            `解析出的题目也仍留在任务记录里（不会出现在「我的题目」中）。`
          }
          confirmText="确认放弃"
          destructive
          onConfirm={discardJob}
          onClose={() => setDiscardOpen(false)}
        />
      )}

      {job.status === "discarded" ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
          这个任务已放弃：不能再继续解析或入库。已生成的草稿不受影响，解析出的题目仍留在这条任务记录里。
          需要重新导入请点右上角「新建另一个任务」。
        </p>
      ) : tab === "run" ? (
        // 跑批期间靠 RPC 回传的进度就地合并（不查库）；重试/跳过这类手动动作才去查
        <ImportRun
          job={job}
          pages={pages}
          fileRef={fileRef}
          onProgressPatch={applyProgress}
          onProgress={() => refresh(false)}
          onFinished={() => refresh(true)}
          onRePick={() => fileInputRef.current?.click()}
        />
      ) : (
        <ImportPreview job={job} items={items} onRefresh={refresh} />
      )}
    </div>
  )
}
