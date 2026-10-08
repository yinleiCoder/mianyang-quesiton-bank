"use client"

// AI 报告的生成与展示（**整条链路在浏览器里跑**）。
//
// 为什么是客户端而不是服务端路由：DeepSeek 的密钥只存在教师自己的浏览器里
// （lib/deepseek-prefs.js），站点不提供公共密钥、也不承担费用 —— 与导入解析同一条路
// （见 lib/deepseek.js 与 lib/import-parse-client.js 的头注）。服务端只做两件事：
// 把数据给出来（class_ai_payload）、把结果存下来（save_class_ai_report）。
//
// 生成是**三步**，中间任何一步失败都不写库：取数据 → 调模型 → 存结果。
// 存的时候必须把服务端给的 fingerprint 原样带回去：生成期间要是又有人交卷/判分，
// 服务端会拒收（40001），页面提示重新生成 —— 而不是把一份对不上号的结论存进"当前学情"。

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { getDeepSeekKey, getDeepSeekModel } from "@/lib/deepseek-prefs"
import { callChat, salvageJson } from "@/lib/deepseek"
import { buildAiReportMessages, validateAiReport } from "@/lib/ai-report-prompt"
import { loadClassAiPayload, saveClassAiReport } from "@/lib/class-ai"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { fmtDateTime24 } from "@/lib/format"
import { DeepSeekSettingsPanel } from "@/components/import/deepseek-settings-panel"
import { AiReportView } from "@/components/classes/ai-report-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2Icon, SparklesIcon, TriangleAlertIcon } from "lucide-react"

export function AiReportPanel({ paperId, classId, initial, paperTitle }) {
  const router = useRouter()
  const { ready, masked } = useDeepSeekPrefs()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  const [error, setError] = useState(null)

  const report = initial?.report ?? null
  const stale = Boolean(initial?.stale)
  const summary = initial?.summary ?? {}

  async function generate() {
    setError(null)
    const apiKey = getDeepSeekKey()
    if (!apiKey) {
      setError("还没有配置 DeepSeek 密钥 —— 在下面粘贴你自己的密钥后就能生成。")
      return
    }
    const model = getDeepSeekModel()
    setBusy(true)
    const supabase = createClient()
    try {
      // 1) 取数据（服务端给的就是要发给模型的那份，含"学生N"编号，没有姓名）
      const { data, error: loadErr } = await loadClassAiPayload(supabase, { paperId, classId })
      if (loadErr || !data) throw new Error(loadErr?.message || "取不到这次考试的数据")

      // 2) 调模型
      const res = await callChat({
        messages: buildAiReportMessages(data.payload, { progressNote: note }),
        apiKey,
        model,
        maxTokens: 8000,
      })
      const check = validateAiReport(salvageJson(res.content))
      if (!check.ok) {
        setError(`模型没有按格式返回（${check.reason}）。再点一次「生成」通常会好。`)
        return
      }

      // 3) 存结果
      const saved = await saveClassAiReport(supabase, {
        paperId,
        classId,
        fingerprint: data.fingerprint,
        content: check.report,
        model,
      })
      if (saved.stale) {
        setError("生成期间这份卷子的成绩又有更新，这份结论已经对不上号了 —— 请重新生成。")
        return
      }
      if (saved.error) throw new Error(saved.error.message || "保存失败")
      toast.success("分析已生成，本班教师共用")
      router.refresh()
    } catch (e) {
      setError(e?.message ?? "生成失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-sm">AI 分析</CardTitle>
          {report && (
            <span className="text-xs text-muted-foreground">
              {fmtDateTime24(report.created_at)}
              {report.model ? ` · ${report.model}` : ""} ·{" "}
              {report.created_by_name || (report.author_left ? "（生成者已注销）" : "（未知生成者）")}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {stale && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            生成之后这个班又有新的交卷或判分，下面这份结论对应的已经不是最新的成绩了 ——
            重新生成一次才准。
          </p>
        )}

        {report ? (
          <AiReportView report={report.content} />
        ) : (
          <p className="text-sm text-muted-foreground">
            还没有生成过分析。点下面的按钮，AI 会读这份卷子的<b>全班作答</b>（逐题正确率、选项分布、
            知识点），给你一份整体表现 + 知识点掌握 + 易错短板 + 下一步复习的建议。
          </p>
        )}

        {error && (
          <p className="rounded-lg border border-rose-300 bg-rose-50/60 px-3 py-2 text-xs text-rose-900">
            {error}
          </p>
        )}

        {ready && masked ? (
          <div className="space-y-3 border-t pt-3">
            <div className="space-y-1.5">
              <Label htmlFor="ai-progress" className="text-xs">
                近期复习进度（可选）
              </Label>
              <Input
                id="ai-progress"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如：这周复习到 Excel 函数与单元格引用"
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                填了它，「下一步复习」会从你复习到的位置接上；不填就按本班最近 30 天的练习记录推断
                （练到过的算教过，没练过的算还没到）。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={generate} disabled={busy}>
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SparklesIcon className="size-4" />}
                {busy ? "正在分析…" : report ? "重新生成" : "生成 AI 分析"}
              </Button>
              <span className="text-xs text-muted-foreground">
                发给模型的只有"学生1、学生2"这样的编号，
                <b>不含学生姓名</b>（实名名单在「试题分析」页）。
                {Number(summary.participants) > 0 ? `本次 ${summary.participants} 人有成绩` : ""}
              </span>
            </div>
            <DeepSeekSettingsPanel compact purpose="analyze" />
          </div>
        ) : ready ? (
          <DeepSeekSettingsPanel purpose="analyze" />
        ) : (
          <div className="h-14 animate-pulse rounded-xl border bg-muted/40" />
        )}

        {paperTitle && (
          <p className="text-xs text-muted-foreground">
            分析对象：{paperTitle} · 本班成绩（同一份卷面只有第一次交卷计入）。
          </p>
        )}
      </CardContent>
    </Card>
  )
}
