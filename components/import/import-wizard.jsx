"use client"

// 新建导入任务：选文件 → 探测文字层 → 定范围 → 试跑 → 配默认值 → 建任务。
//
// 关键设计：**源文件只在浏览器内存里**（上百兆的 PDF 不上传），所以向导创建任务后
// 不能跳转到别的路由——一跳转 File 对象就没了。这里用 onCreated 回调把控制权交回容器，
// 由容器原地切到工作台，同一个页面、同一份内存。
//
// 解析执行（跑批）在 import-run.jsx；这里只准备任务参数。

import { useRef, useState } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { SOURCE_KINDS, jobStateChip } from "@/lib/import-jobs"
import { docxWindow } from "@/lib/docx-client"
import { trialParse } from "@/lib/import-parse-client"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { NodeField } from "@/components/questions/node-field"
import { TagPicker } from "@/components/questions/tag-picker"
import { DeepSeekSettingsPanel } from "@/components/import/deepseek-settings-panel"
import { Loader2Icon, FileUpIcon, ScanTextIcon, ImageIcon } from "lucide-react"

const ACCEPT = ".pdf,.docx,image/png,image/jpeg,image/webp"
const PROBE_SAMPLE = 12 // 抽样探测页数上限：几十页的卷子不必逐页探测，抽样足够判断版面

// 探测一批页，返回每页的 { pageNo, hasText, hasImage, columns }
async function probePages(pdf, pageNos) {
  const out = []
  for (const no of pageNos) {
    try {
      const p = await pdf.probe(no)
      out.push({ pageNo: no, ...p })
    } catch {
      out.push({ pageNo: no, hasText: false, hasImage: false, columns: 1, error: true })
    }
  }
  return out
}

// 页码均匀抽样：首尾 + 中间等距，避免"只看了第一页就下结论"
function samplePages(from, to, max) {
  const total = to - from + 1
  if (total <= max) return Array.from({ length: total }, (_, i) => from + i)
  const step = (total - 1) / (max - 1)
  return [...new Set(Array.from({ length: max }, (_, i) => from + Math.round(i * step)))].sort(
    (a, b) => a - b
  )
}

export function ImportWizard({ nodes, jobs, fileRef, onCreated, onResume }) {
  const [picked, setPicked] = useState(null) // { kind, name, pages, sizeMB, handle }
  const [probed, setProbed] = useState(null) // { samples, total, textPages, scanPages }
  const [from, setFrom] = useState(1)
  const [to, setTo] = useState(1)
  const [title, setTitle] = useState("")
  const [nodeId, setNodeId] = useState("")
  const [tags, setTags] = useState([]) // TagPicker 的值是 {id,name} 对象数组，入库前要 .map(t => t.id)
  const [difficulty, setDifficulty] = useState(2)
  const [genAnalysis, setGenAnalysis] = useState(true)
  // 整卷还原模式：提示词换成 PAPER_TAIL，额外抽卷头/大题/分值，解析完可「一键成卷」
  const [paperMode, setPaperMode] = useState(false)
  const [busy, setBusy] = useState("")
  const [trial, setTrial] = useState(null)
  // 没有密钥就整块禁用（本功能不提供公共密钥，见 DeepSeekSettingsPanel）。
  // 用 hook 而不是 useState 初始化：密钥在 localStorage 里，SSR 阶段读不到
  const { hasKey, ready: keyReady, refresh: refreshKey } = useDeepSeekPrefs()

  const inputRef = useRef(null)

  async function handleFiles(files) {
    const list = Array.from(files ?? [])
    if (list.length === 0) return
    const first = list[0]
    const name = first.name
    setTrial(null)
    setProbed(null)
    setBusy("open")
    try {
      if (/\.pdf$/i.test(name)) {
        const { openPdf } = await import("@/lib/pdf-client")
        const pdf = await openPdf(first)
        const pages = pdf.pageCount
        setPicked({ kind: "pdf", name, pages, sizeMB: Math.round(first.size / 1048576), handle: pdf })
        setFrom(1)
        setTo(pages)
        setTitle(name.replace(/\.pdf$/i, ""))
        fileRef.current = { kind: "pdf", name, handle: pdf, files: [first] }
      } else if (/\.docx$/i.test(name)) {
        const { extractDocx } = await import("@/lib/docx-client")
        const doc = await extractDocx(first)
        if (doc.charCount === 0) throw new Error("Word 文档里没有可提取的文字（可能是扫描件导出的图片）")
        setPicked({
          kind: "docx",
          name,
          pages: doc.paragraphs.length,
          sizeMB: Math.round(first.size / 1048576),
          doc,
        })
        setFrom(1)
        setTo(doc.paragraphs.length)
        setTitle(name.replace(/\.docx$/i, ""))
        fileRef.current = { kind: "docx", name, doc, files: [first] }
      } else if (list.every((f) => /^image\//.test(f.type))) {
        setPicked({
          kind: "image",
          name: list.length > 1 ? `${name} 等 ${list.length} 张` : name,
          pages: list.length,
          sizeMB: Math.round(list.reduce((a, f) => a + f.size, 0) / 1048576),
        })
        setFrom(1)
        setTo(list.length)
        setTitle(name.replace(/\.(png|jpe?g|webp)$/i, ""))
        fileRef.current = { kind: "image", name, files: list, images: await Promise.all(list.map(readImage)) }
      } else {
        throw new Error("只支持 PDF、Word(.docx) 与图片（png/jpg/webp）；一个任务只放一种格式")
      }
    } catch (err) {
      fileRef.current = null
      setPicked(null)
      toast.error(err?.message ?? "文件读取失败")
    } finally {
      setBusy("")
    }
  }

  // 探测：判断这段范围是文字版还是扫描件（决定走文本路径还是视觉路径）
  async function handleProbe() {
    if (picked?.kind !== "pdf" || busy) return
    setBusy("probe")
    try {
      const samples = await probePages(picked.handle, samplePages(from, to, PROBE_SAMPLE))
      const textPages = samples.filter((s) => s.hasText).length
      setProbed({ samples, total: samples.length, textPages, scanPages: samples.length - textPages })
      if (textPages === 0) {
        toast.warning("抽样页都没有文字层，看起来是扫描件——会按图片路径解析（费用与耗时更高）")
      } else if (textPages < samples.length) {
        toast.info(`抽样 ${samples.length} 页中有 ${samples.length - textPages} 页是扫描件，将逐页自动判断`)
      } else {
        toast.success("抽样页都有文字层，走文本路径（最省费用）")
      }
    } catch (err) {
      toast.error(err?.message ?? "探测失败")
    } finally {
      setBusy("")
    }
  }

  // 试跑：花几十秒先看一眼效果，避免一次跑 40 分钟才发现模式不对
  async function handleTrial() {
    if (!picked || busy) return
    setBusy("trial")
    setTrial(null)
    try {
      const page = await buildPagePayload(fileRef.current, from, "auto")
      // 有自己的密钥就浏览器直连上游（密钥不经过本站服务器），否则走站点兜底
      const json = await trialParse({
        page,
        opts: { genAnalysis, defaultDifficulty: difficulty, paperMode },
      })
      const r = json.results?.[0]
      setTrial({ pageNo: from, mode: json.mode, ...r })
      if (r?.ok) toast.success(`试跑成功：第 ${from} 页抽到 ${r.items?.length ?? 0} 道题`)
      else toast.error(`试跑未通过：${r?.error ?? "未知原因"}`)
    } catch (err) {
      toast.error(err?.message ?? "试跑失败")
    } finally {
      setBusy("")
    }
  }

  async function handleCreate() {
    if (busy) return
    if (!picked) return toast.error("请先选择文件")
    if (!nodeId) return toast.error("请选择这批题目的科目节点")
    if (!title.trim()) return toast.error("请填写任务名称")
    setBusy("create")
    try {
      const supabase = createClient()
      const { data: jobId, error } = await supabase.rpc("import_create_job", {
        p_course_node: nodeId,
        p_title: title.trim(),
        p_source: {
          kind: picked.kind,
          name: picked.name,
          pages: picked.pages,
          sha256: fileRef.current?.sha256 ?? null,
        },
        p_page_from: from,
        p_page_to: to,
        p_answer: { mode: "embedded" },
        p_tag_ids: tags.map((t) => t.id),
        p_defaults: { gen_analysis: genAnalysis, difficulty },
      })
      if (error) throw new Error(error.message)
      // 模式另走一个小 RPC：import_create_job 改签名要 drop 旧函数，风险不值当
      if (paperMode) {
        const { error: modeErr } = await supabase.rpc("import_set_paper_mode", { p_job_id: jobId })
        if (modeErr) throw new Error(modeErr.message)
      }
      toast.success("任务已创建，开始解析")
      onCreated(jobId)
    } catch (err) {
      toast.error(err?.message ?? "创建任务失败")
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="space-y-5">
      <DeepSeekSettingsPanel onChange={refreshKey} />

      {/* 没有密钥时整块禁用：fieldset 会连带禁用里面的 input/button，不用逐个加 disabled。
          keyReady 为 false（还没读到密钥）时同样按未配置处理，服务端与客户端首帧一致 */}
      <fieldset
        disabled={!hasKey || !keyReady}
        className={hasKey ? "space-y-5" : "space-y-5 opacity-50"}
      >
      <div className="rounded-xl border p-4">
        <Label className="mb-2 block">1. 选择文件</Label>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={!!busy}>
            {busy === "open" ? <Loader2Icon className="size-4 animate-spin" /> : <FileUpIcon className="size-4" />}
            选择 PDF / Word / 图片
          </Button>
          {picked && (
            <span className="text-sm text-muted-foreground">
              {picked.name} · {SOURCE_KINDS[picked.kind]} · {picked.sizeMB}MB ·{" "}
              {picked.kind === "docx" ? `${picked.pages} 个段落` : `${picked.pages} 页`}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          文件<b>不会上传</b>，只在你的浏览器里读取——所以几百兆的卷子也能导入。关闭页面后需要重新选择同一个文件才能继续。
          {picked?.kind === "docx" && " Word 文档没有「页」的概念（页码是排版结果），所以下面按段落范围选择。"}
        </p>
      </div>

      {picked && (
        <div className="rounded-xl border p-4">
          <Label className="mb-2 block">
            2. 导入范围{picked.kind === "docx" ? "（段落）" : "（页）"}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={1}
              max={picked.pages}
              value={from}
              onChange={(e) => setFrom(Math.max(1, Math.min(picked.pages, Number(e.target.value) || 1)))}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">到</span>
            <Input
              type="number"
              min={from}
              max={picked.pages}
              value={to}
              onChange={(e) => setTo(Math.max(from, Math.min(picked.pages, Number(e.target.value) || from)))}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">
              共 {to - from + 1} {picked.kind === "docx" ? "段" : "页"}
            </span>
            {picked.kind === "pdf" && (
              <Button variant="outline" size="sm" onClick={handleProbe} disabled={!!busy}>
                {busy === "probe" && <Loader2Icon className="size-4 animate-spin" />}
                <ScanTextIcon className="size-4" />
                检测文字层
              </Button>
            )}
          </div>
          {probed && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline">抽样 {probed.total} 页</Badge>
              <span className="text-emerald-700">文字版 {probed.textPages} 页</span>
              <span className="text-amber-700">扫描件 {probed.scanPages} 页</span>
              <span className="text-muted-foreground">
                逐页自动判断：有文字层走文本路径（便宜），没有或含图才送图片
              </span>
            </div>
          )}
          {!probed && (
            <p className="mt-2 text-xs text-muted-foreground">
              可以先「检测文字层」看看这段是文字版还是扫描件——扫描件要送图片给模型，费用与耗时都更高。
            </p>
          )}
        </div>
      )}

      {picked && (
        <div className="rounded-xl border p-4">
          <Label className="mb-2 block">3. 试跑一页（可选，但强烈建议）</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleTrial} disabled={!!busy}>
              {busy === "trial" ? <Loader2Icon className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
              试跑第 {from} {picked.kind === "docx" ? "段" : "页"}
            </Button>
            <span className="text-xs text-muted-foreground">
              先花几十秒看一眼效果，比跑完 200 页才发现切图模式不对划算得多
            </span>
          </div>
          {trial && (
            <div className="mt-3 space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
              {trial.ok ? (
                <>
                  <p>
                    抽到 <b>{trial.items?.length ?? 0}</b> 道题
                    {trial.stats?.dropped > 0 && `（另有 ${trial.stats.dropped} 段内容没识别成题目）`}
                    {trial.readability && ` · 可读性 ${trial.readability}`}
                  </p>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {(trial.items ?? []).slice(0, 3).map((it, i) => (
                      <li key={i} className="line-clamp-2">
                        [{it.qtype}] {it.content?.stem?.[0]?.text ?? ""}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-rose-600">试跑未通过：{trial.error}</p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border p-4">
        <Label className="mb-2 block">4. 这批题目的归属与默认值</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="imp-title" className="text-xs text-muted-foreground">
              任务名称（便于在历史任务里找到它）
            </Label>
            <Input
              id="imp-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="如：2024 计算机应用期末试卷"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">科目节点（整批共用，导入后可在编辑器里改）</Label>
            <NodeField nodes={nodes} value={nodeId} onChange={setNodeId} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">知识点标签（可后补）</Label>
            <TagPicker value={tags} onChange={setTags} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">默认难度</Label>
            <div className="flex gap-1.5">
              {[1, 2, 3].map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={difficulty === d ? "default" : "outline"}
                  onClick={() => setDifficulty(d)}
                >
                  {d === 1 ? "易" : d === 2 ? "中" : "难"}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={genAnalysis}
            onChange={(e) => setGenAnalysis(e.target.checked)}
            className="size-4"
          />
          原卷没有解析时，让模型补写一段解析（会在解析上标记「AI 解析」）
        </label>
        <label className="mt-2 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={paperMode}
            onChange={(e) => setPaperMode(e.target.checked)}
            className="mt-0.5 size-4"
          />
          <span>
            这是一份<strong>完整试卷</strong>，按整卷还原
            <span className="mt-0.5 block text-xs text-muted-foreground">
              会额外抽取卷头（考试名称/时长/总分）、大题分节与每题分值，解析完可以「一键成卷」；
              题目本身仍然照常先进题库草稿、走两级审核。
            </span>
          </span>
        </label>
        {/* 答案规则（0054 起）：原卷有答案照抄；没有就由模型自己解出来并标成
            「AI 推导答案」，教师在校对页逐题核对或改写。这里先说清楚，
            免得教师以为紫色标记是解析出错。 */}
        <p className="mt-3 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs text-violet-900">
          <strong>答案怎么来。</strong>
          原卷上有答案就照抄；<strong>没有的话模型会自己把题解出来</strong>，标成
          「AI 推导答案」并在解析里写出推导过程，供你核对。实在解不出的会标成「缺答案」，
          入库时被数据库拦下，需要你手工补。
          <span className="mt-0.5 block">
            所以：原卷没答案也能用，但校对页的核对工作会更多——AI 推的答案请务必看一遍推导再放行。
          </span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={handleCreate} disabled={!!busy || !picked}>
          {busy === "create" && <Loader2Icon className="size-4 animate-spin" />}
          创建任务并开始解析
        </Button>
        <span className="text-xs text-muted-foreground">
          解析结果先进「待校对」，确认无误后才生成草稿——不会直接进审核流。
        </span>
      </div>

      </fieldset>

      {jobs.length > 0 && (
        <div className="rounded-xl border">
          <p className="border-b px-4 py-2 text-sm font-medium">历史导入任务</p>
          <div className="divide-y">
            {jobs.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => onResume(j.id)}
                className="flex w-full flex-wrap items-center gap-2 px-4 py-2 text-left text-sm hover:bg-accent/40"
              >
                <span className="font-medium">{j.title}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${jobStateChip(j.status).cls}`}>
                  {jobStateChip(j.status).text}
                </span>
                <span className="text-xs text-muted-foreground">
                  {SOURCE_KINDS[j.source_kind]} · 第 {j.page_from}-{j.page_to} 页
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  已解析 {j.done_pages}/{j.total_pages} 页 · 题 {j.item_count} · 已入库 {j.imported_count}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- 素材构造（向导试跑与跑批共用） ----------

export async function readImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error("图片读取失败"))
    fr.readAsDataURL(file)
  })
  return { dataUrl, name: file.name }
}

/**
 * 把「第 pageNo 页」变成接口要的素材：文字路径给 text，视觉路径给图片切片。
 * mode 传 "auto" 时按该页实际情况判断（有文字层走文本，含图额外附一张低清图）。
 *
 * 参数**只有一个源对象**（fileRef.current 的规范形状，见下），不要再加第二个对象——
 * 之前这里同时收 picked 与 handle 两个对象，而它们的键名不一样（handle vs pdf），
 * 结果跑批循环传进来时 `picked.handle` 是 undefined，报「Cannot read properties of undefined (reading 'probe')」。
 *
 * 规范形状：{ kind: "pdf"|"docx"|"image", name, handle?, doc?, images?, files }
 *   · pdf   → handle 是 lib/pdf-client 的句柄（probe/getPageText/renderPage/destroy）
 *   · docx  → doc 是 lib/docx-client 的结果（paragraphs/text）
 *   · image → images 是按页序排好的 [{ dataUrl, name }]
 */
export async function buildPagePayload(file, pageNo, mode = "auto", detail = "high") {
  if (!file) throw new Error("文件已不在内存里（刷新过页面？），请重新选择同一个文件再继续")
  if (file.kind === "image") {
    const img = file.images[pageNo - 1]
    if (!img) throw new Error(`第 ${pageNo} 张图片不存在（选择的图片数量对不上）`)
    return { page_no: pageNo, mode: "vision", images: [{ data_url: img.dataUrl, w: 0, h: 0 }], detail }
  }
  if (file.kind === "docx") {
    // Word 没有页：这里把若干段落拼成一批，range 的"页"即段落序号。
    // 窗口边界要按内容对齐——固定切 5 段会把"题干在窗口内、选项在窗口外"的题切出来，
    // 那种题在入库时必然被判为缺选项（见 lib/docx-client.js 的 docxWindow）
    const win = docxWindow(file.doc.paragraphs, pageNo)
    return {
      page_no: pageNo,
      mode: "text",
      text: win.text,
      note: win.extendedForward > 0 || win.extendedBackward > 0
        ? `本批为 Word 段落（为对齐题目边界，向${win.extendedBackward > 0 ? "前 " + win.extendedBackward + " 段" : ""}${win.extendedBackward > 0 && win.extendedForward > 0 ? "、" : ""}${win.extendedForward > 0 ? "后 " + win.extendedForward + " 段" : ""}扩了窗口）`
        : "本批为 Word 段落",
    }
  }
  if (!file.handle) throw new Error("PDF 句柄已失效，请重新选择文件")
  const p = await file.handle.probe(pageNo)
  const useMode = mode === "auto" ? (!p.hasText ? "vision" : p.hasImage ? "hybrid" : "text") : mode
  const payload = { page_no: pageNo, mode: useMode }
  if (useMode === "text" || useMode === "hybrid") {
    payload.text = await file.handle.getPageText(pageNo)
  }
  if (useMode === "vision" || useMode === "hybrid") {
    // 上下切两片（1×2）：按官方 1300×1300 的缩放目标，A4@180dpi 每片约 1.57M 像素，
    // 正好在阈值内——不再被上游二次缩放，宽度还比整页送多约 36%
    const rendered = await file.handle.renderPage(pageNo, { mode: "tiles", columns: 1, rows: 2 })
    payload.images = rendered.tiles.map((t) => ({ data_url: t.dataUrl, w: t.w, h: t.h }))
    payload.detail = detail
  }
  return payload
}
