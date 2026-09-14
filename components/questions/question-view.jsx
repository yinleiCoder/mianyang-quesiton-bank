// 只读题目渲染（审批详情/题库预览共用）。showAnswer=false 时隐藏答案与解析（公众视角）；
// 审核视角 showAnswer=true 需看到答案才能判断。媒体块按 object_key 拼 CNAME 公网域名真实渲染。
import { blocksToText, qtypeLabel } from "@/lib/question-model"
import { objectUrl } from "@/lib/oss-url"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2Icon, FileIcon } from "lucide-react"

function BlockView({ block }) {
  if (!block) return null
  if (block.t === "text") {
    const t = block.text ?? ""
    return t ? <p className="whitespace-pre-wrap">{t}</p> : null
  }
  if (block.t === "media") {
    const src = objectUrl(block.key ?? block.url)
    if (!src) return null
    if (block.kind === "audio") return <audio controls src={src} className="h-9 w-full" />
    if (block.kind === "video") return <video controls src={src} className="max-h-80 rounded-md" />
    // 文件附件（pdf/office/txt 等）：展示原始文件名（alt），点击新页打开/下载
    if (block.kind === "file") {
      const name = block.alt || "附件文件"
      return (
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs hover:bg-muted/70"
        >
          <FileIcon className="size-3.5 shrink-0" />
          <span className="truncate">{name}</span>
          <span className="shrink-0 text-muted-foreground">查看/下载附件 ↗</span>
        </a>
      )
    }
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={block.alt ?? ""} className="max-h-80 rounded-md object-contain" />
    )
  }
  return null
}

export function BlockList({ blocks }) {
  const list = Array.isArray(blocks) ? blocks : []
  if (list.length === 0) return null
  return (
    <div className="space-y-1">
      {list.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  )
}

function OptionRow({ letter, block, correct }) {
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${
        correct ? "border-emerald-300 bg-emerald-50/60" : "border-border/60"
      }`}
    >
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
        {letter}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <BlockList blocks={block} />
      </div>
      {correct && <CheckCircle2Icon className="mt-1 size-4 shrink-0 text-emerald-600" />}
    </div>
  )
}

// 单题渲染（根题或子题）。qtype 必传；content 为该题内容（子题为 content.sub[] 元素）
export function QuestionBody({ qtype, content, showAnswer = false, prefix = "" }) {
  const c = content ?? {}
  const answer = c.answer ?? {}
  const isChoice = qtype === "single_choice" || qtype === "multiple_choice"
  const answerKeys = new Set(Array.isArray(answer.keys) ? answer.keys : [])
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium leading-relaxed">
        <BlockList blocks={c.stem} />
      </div>

      {isChoice && (c.options?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">选项</p>
          {(c.options ?? []).map((o, i) => (
            <OptionRow
              key={o.key ?? i}
              letter={o.key ?? String.fromCharCode(65 + i)}
              block={o.label}
              correct={showAnswer && answerKeys.has(o.key)}
            />
          ))}
          {showAnswer && answerKeys.size > 0 && (
            <p className="flex items-center gap-1.5 pt-1 text-sm">
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
                正确答案
              </span>
              <span className="font-semibold text-emerald-700">{[...answerKeys].join("、")}</span>
            </p>
          )}
        </div>
      )}

      {showAnswer && qtype === "true_false" && (
        <p className="text-sm">
          正确答案：
          <span className="font-semibold text-emerald-700">
            {/* 显式判定：脏数据（值为 null/缺失）不能被显示成「错误」 */}
            {answer.value === true ? "正确" : answer.value === false ? "错误" : "—"}
          </span>
        </p>
      )}
      {showAnswer && qtype === "fill_blank" && (
        <p className="text-sm">
          参考答案：{(answer.values ?? []).map((x, i) => `${i + 1}. ${x}`).join("　")}
        </p>
      )}
      {showAnswer && qtype === "short_answer" && (
        <div className="rounded-lg bg-muted/60 p-3 text-sm">
          <p className="mb-1 font-medium text-muted-foreground">参考答案</p>
          {(answer.samples ?? []).map((s, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {s}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// 整卷渲染：六题型统一入口。composite 渲染材料 + 子题列表
export function QuestionView({ qtype, content, showAnswer = false }) {
  const c = content ?? {}
  const subs = Array.isArray(c.sub) ? c.sub : []
  if (qtype === "composite") {
    return (
      <div className="space-y-5">
        {blocksToText(c.stem).trim() && (
          <div className="rounded-lg border-l-4 border-primary/40 bg-muted/30 py-2 pl-3 pr-2 text-sm leading-relaxed">
            <BlockList blocks={c.stem} />
          </div>
        )}
        <div className="space-y-5">
          {subs.map((sub, i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline">子题 {i + 1}</Badge>
                <span className="text-xs text-muted-foreground">{qtypeLabel(sub.type)}</span>
              </div>
              <QuestionBody qtype={sub.type} content={sub} showAnswer={showAnswer} />
            </div>
          ))}
        </div>
        {showAnswer && blocksToText(c.analysis).trim() && (
          <div className="rounded-lg bg-muted/60 p-3 text-sm">
            <p className="mb-1 font-medium text-muted-foreground">解析</p>
            <BlockList blocks={c.analysis} />
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <QuestionBody qtype={qtype} content={c} showAnswer={showAnswer} />
      {showAnswer && blocksToText(c.analysis).trim() && (
        <div className="rounded-lg bg-muted/60 p-3 text-sm">
          <p className="mb-1 font-medium text-muted-foreground">解析</p>
          <BlockList blocks={c.analysis} />
        </div>
      )}
    </div>
  )
}
