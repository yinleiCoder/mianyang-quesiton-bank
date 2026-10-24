import { arr } from "@/lib/ai-report-prompt"
import { qtypeShortLabel } from "@/lib/question-model"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Reveal } from "@/components/ui/reveal"

// 渲染一份 AI 报告（0088 存下来的结构化 json，0113 起增加了更多维度）。
//
// **每一段都可能缺**：模型偶尔会漏字段（提示词要求了，但它不是编译器）。这里一律按"缺了就整段不渲染"
// 处理，而不是渲染出"undefined"或空标题 —— 页面上少一段，教师不会当成系统坏了；
// 多一个空白标题，他会以为分析失败了。
export function AiReportView({ report }) {
  const c = report ?? {}
  const strengths = arr(c.strengths)
  const keyPoints = arr(c.key_points)
  const weak = arr(c.weak_points)
  const notes = arr(c.question_notes)
  const plan = c.plan && typeof c.plan === "object" ? c.plan : {}
  const planRows = [
    { key: "consolidate", label: "知识巩固", items: arr(plan.consolidate) },
    { key: "extend", label: "适度拓展", items: arr(plan.extend) },
    { key: "improve", label: "能力提升", items: arr(plan.improve) },
  ].filter((r) => r.items.length > 0)

  const score = c.score_analysis && typeof c.score_analysis === "object" ? c.score_analysis : null
  const scoreRows = score
    ? [
        ["summary", "总体", score.summary],
        ["pass_rate", "及格率", score.pass_rate],
        ["excellent_rate", "优秀率", score.excellent_rate],
        ["distribution", "分数段", score.distribution],
      ].filter(([, , v]) => text(v))
    : []

  const qtypes = arr(c.question_type_analysis).filter((r) => r && text(r.qtype))
  const difficulties = arr(c.difficulty_analysis).filter((r) => r && text(r.difficulty))
  const tiers = arr(c.student_tiers).filter((r) => r && text(r.tier))
  const errors = arr(c.error_analysis).filter((r) => r && (text(r.label) || text(r.evidence)))
  const levels = arr(c.subjective_levels).filter((r) => r && (text(r.solo_level) || text(r.evidence)))
  const time = c.time_management && typeof c.time_management === "object" ? c.time_management : null
  const actions = arr(c.action_plan).filter((r) => r && text(r.action))

  return (
    <Reveal className="space-y-4" stagger={0.05}>
      {text(c.overview) && (
        <SectionCard title="整体表现">
          <p className="text-sm leading-relaxed whitespace-pre-line">{c.overview}</p>
        </SectionCard>
      )}

      {scoreRows.length > 0 && (
        <SectionCard title="成绩分布与关键指标">
          <dl className="space-y-1.5 text-sm">
            {scoreRows.map(([key, label, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="w-14 shrink-0 text-xs text-muted-foreground">{label}</dt>
                <dd className="min-w-0 flex-1 whitespace-pre-line">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>
      )}

      {strengths.length > 0 && (
        <SectionCard title="做得好的地方">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {strengths.map((s, i) => (
              <li key={i}>{String(s)}</li>
            ))}
          </ul>
        </SectionCard>
      )}

      {keyPoints.length > 0 && (
        <SectionCard title="知识点掌握">
          <div className="space-y-2">
            {keyPoints.map((k, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                <MasteryChip value={k?.mastery} />
                <span className="font-medium">{k?.point ?? "（未命名知识点）"}</span>
                {text(k?.evidence) && (
                  <span className="text-xs text-muted-foreground">{String(k.evidence)}</span>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {(qtypes.length > 0 || difficulties.length > 0) && (
        <SectionCard title="题型与难度表现">
          <div className="grid gap-4 md:grid-cols-2">
            {qtypes.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">按题型</p>
                <ul className="space-y-1.5 text-sm">
                  {qtypes.map((r, i) => (
                    <li key={i}>
                      <span className="font-medium">{qtypeText(r.qtype)}</span>
                      {text(r.accuracy) && <span className="ml-2 text-xs text-muted-foreground">{String(r.accuracy)}</span>}
                      {text(r.note) && <p className="text-xs text-muted-foreground">{String(r.note)}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {difficulties.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">按难度</p>
                <ul className="space-y-1.5 text-sm">
                  {difficulties.map((r, i) => (
                    <li key={i}>
                      <span className="font-medium">{difficultyText(r.difficulty)}</span>
                      {text(r.accuracy) && <span className="ml-2 text-xs text-muted-foreground">{String(r.accuracy)}</span>}
                      {text(r.note) && <p className="text-xs text-muted-foreground">{String(r.note)}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {weak.length > 0 && (
        <SectionCard title="易错短板">
          <div className="space-y-2.5">
            {weak.map((w, i) => (
              <div key={i} className="space-y-0.5 text-sm">
                <p className="font-medium">{w?.point ?? "（未命名知识点）"}</p>
                {text(w?.evidence) && <p className="text-xs text-muted-foreground">{String(w.evidence)}</p>}
                {text(w?.suggestion) && <p className="text-xs">课堂建议：{String(w.suggestion)}</p>}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {tiers.length > 0 && (
        <SectionCard title="学生分层与重点关注">
          <div className="space-y-2.5">
            {tiers.map((t, i) => (
              <div key={i} className="space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <TierChip value={t.tier} />
                  {labels(t.students).map((s) => (
                    <span key={s} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {s}
                    </span>
                  ))}
                </div>
                {text(t.reason) && <p className="text-xs text-muted-foreground">{String(t.reason)}</p>}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {errors.length > 0 && (
        <SectionCard title="典型错误归因（归类 / 看人）">
          <div className="space-y-2.5">
            {errors.map((e, i) => (
              <div key={i} className="space-y-1 border-l-2 border-rose-200 pl-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <span className="font-medium tabular-nums">第 {Number(e.seq) || "?"} 题</span>
                  <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-800">
                    {text(e.error_code) || "未编码"}
                  </span>
                  {text(e.label) && <span>{String(e.label)}</span>}
                </div>
                {labels(e.students).length > 0 && (
                  <p className="text-xs text-muted-foreground">涉及：{labels(e.students).join("、")}</p>
                )}
                {text(e.evidence) && <p className="text-xs text-muted-foreground">{String(e.evidence)}</p>}
                {text(e.suggestion) && <p className="text-xs">怎么讲：{String(e.suggestion)}</p>}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {levels.length > 0 && (
        <SectionCard title="主观题思维层级（SOLO）">
          <div className="space-y-2.5">
            {levels.map((l, i) => (
              <div key={i} className="space-y-1 border-l-2 border-indigo-200 pl-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <span className="font-medium tabular-nums">第 {Number(l.seq) || "?"} 题</span>
                  <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-800">
                    {text(l.solo_level) || "未分级"}
                  </span>
                  {labels(l.students).length > 0 && (
                    <span className="text-xs text-muted-foreground">{labels(l.students).join("、")}</span>
                  )}
                </div>
                {text(l.evidence) && (
                  <p className="border-l border-muted-foreground/30 pl-2 text-xs italic text-muted-foreground">
                    “{String(l.evidence)}”
                  </p>
                )}
                {text(l.bottleneck) && <p className="text-xs">卡点：{String(l.bottleneck)}</p>}
                {text(l.suggestion) && <p className="text-xs">怎么带：{String(l.suggestion)}</p>}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {time && (text(time.summary) || arr(time.metrics).length > 0 || text(time.advice)) && (
        <SectionCard title="时间管理与作答完整度">
          {text(time.summary) && <p className="text-sm">{String(time.summary)}</p>}
          {arr(time.metrics).length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {arr(time.metrics).map((m, i) => (
                <li key={i} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {String(m)}
                </li>
              ))}
            </ul>
          )}
          {text(time.advice) && <p className="mt-1 text-xs">建议：{String(time.advice)}</p>}
        </SectionCard>
      )}

      {notes.length > 0 && (
        <SectionCard title="逐题讲评要点">
          <div className="space-y-1.5 text-sm">
            {notes.map((n, i) => (
              <p key={i}>
                <b className="tabular-nums">第 {Number(n?.seq) || "?"} 题</b>
                <span className="ml-2">{String(n?.note ?? "")}</span>
              </p>
            ))}
          </div>
        </SectionCard>
      )}

      {actions.length > 0 && (
        <SectionCard title="课堂改进行动（定策 / 可验证）">
          <ol className="space-y-2.5">
            {actions.map((a, i) => (
              <li key={i} className="rounded-lg border px-3 py-2 text-sm">
                <p className="font-medium">
                  {i + 1}. {String(a.action)}
                </p>
                <div className="mt-1 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                  {text(a.when) && <span>时间：{String(a.when)}</span>}
                  {text(a.metric) && <span>观察指标：{String(a.metric)}</span>}
                  {text(a.check) && <span>验证：{String(a.check)}</span>}
                </div>
              </li>
            ))}
          </ol>
        </SectionCard>
      )}

      {planRows.length > 0 && (
        <SectionCard title="下一步复习">
          <div className="grid gap-3 sm:grid-cols-3">
            {planRows.map((r) => (
              <div key={r.key} className="rounded-lg border px-3 py-2">
                <p className="text-xs font-medium text-muted-foreground">{r.label}</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
                  {r.items.map((t, i) => (
                    <li key={i}>{String(t)}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {text(c.caveats) && (
        <p className="text-xs text-muted-foreground">数据说明：{String(c.caveats)}</p>
      )}
    </Reveal>
  )
}

function SectionCard({ title, children }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function MasteryChip({ value }) {
  const tone =
    value === "较好"
      ? "bg-emerald-100 text-emerald-800"
      : value === "薄弱"
        ? "bg-rose-100 text-rose-800"
        : value === "一般"
          ? "bg-amber-100 text-amber-800"
          : "bg-muted text-muted-foreground"
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${tone}`}>{value ?? "未评级"}</span>
  )
}

function TierChip({ value }) {
  const tone =
    value === "重点关注"
      ? "bg-rose-100 text-rose-800"
      : value === "表现较好"
        ? "bg-emerald-100 text-emerald-800"
        : "bg-amber-100 text-amber-800"
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${tone}`}>{value}</span>
}

const text = (v) => (typeof v === "string" ? v.trim() : "")

/** 模型可能给数组，也可能给一个字符串；统一成去空后的字符串数组。 */
function labels(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean)
  const s = text(v)
  return s ? [s] : []
}

function qtypeText(v) {
  const s = text(v)
  return s.includes("_") ? qtypeShortLabel(s) : s
}

function difficultyText(v) {
  const n = Number(v)
  if (n === 1) return "易"
  if (n === 2) return "中"
  if (n === 3) return "难"
  return text(v) || "—"
}
