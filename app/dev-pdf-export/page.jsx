// 渲染检查页（fixture）：给「试卷导出 PDF」这条链路过一遍**浏览器里**的真实渲染。
//
// ⚠ **不要删掉它**（2026-10-08 用户要求：删任何东西之前先问）。
//   它只渲染下面写死的假数据，不读数据库、不调上游，任何账号都能打开（不需要登录）。
//
// 为什么需要它：`npm run test:pdf` 跑在 node 里，用的是 react-pdf 的 **node 版**；
// 浏览器里走的是另一份构建（reconciler 不同）、字体要从 /fonts 走 HTTP 取、图片要过 CORS、
// 下载要走 Blob。这几条只有真浏览器能验，而且后端不可达时（supabase.co 被掐）也能用。
//
// 用法：npm run dev → 打开 /dev-pdf-export → 点「下载 PDF」→ 看是不是真的下下来一份。
//
// 是客户端组件：两张样本图要用**本站 origin** 拼绝对地址（public/dev-sample.png /
// .webp），而 origin 只有浏览器知道。所以这里没有 metadata，页面标题就用默认的。
"use client"

import { useEffect, useMemo, useState } from "react"
import { ExportPdfButton } from "@/components/papers/export-pdf-button"
import { PaperSheet } from "@/components/papers/paper-sheet"
import { CorsProbe } from "@/components/papers/cors-probe"

const T = (text) => ({ t: "text", text })

// 两张样本图（public/dev-sample.png 与 .webp）在数据里写成 __ORIGIN__ 开头，
// 挂载后换成真实 origin。用本站绝对地址，不经过 OSS——这样验的是"抓字节 → 嵌图"
// 这条链，不受跨域与后端可达性的影响：
//   · dev-sample.png  → 应当真的被嵌进 PDF
//   · dev-sample.webp → 应当在抓取阶段被嗅探拦下，退化成一行说明（react-pdf 不认 webp，
//     漏到渲染阶段就是整份导出失败）
const ORIGIN_TOKEN = "__ORIGIN__"
const withOrigin = (snapshot, origin) =>
  JSON.parse(JSON.stringify(snapshot).replaceAll(ORIGIN_TOKEN, origin))

const SNAPSHOT = {
  title: "2026 年职教高考语文模拟试卷（导出自检）",
  exam_name: "绵阳市中职学校联合考试",
  subject_label: "语文",
  total_score: 120,
  duration_minutes: 150,
  header: { code: "MY-2026-01", show_candidate_bar: true },
  instructions: [
    T("1. 答题前请将姓名、学号填写在密封线内。\n2. 选择题用 2B 铅笔填涂，非选择题用 0.5mm 黑色签字笔书写。"),
  ],
  sections: [
    {
      id: "s1",
      title: "单项选择题",
      instruction: "每小题只有一个正确选项。",
      score_mode: "each",
      score_each: 3,
      section_score: 9,
      items: [
        {
          id: "q1",
          seq: 1,
          qtype: "single_choice",
          score: 3,
          content: {
            stem: [
              T(
                "下列词语中加点字的读音完全正确的一项是。这一段故意写得很长，用来验证中文长段落能不能自动断行——中文字之间没有空格，如果排版引擎按英文的规矩只在空格处断行，这一整段就会冲出纸面被裁掉，而且不报任何错。"
              ),
              { t: "media", kind: "image", key: `${ORIGIN_TOKEN}/dev-sample.png`, alt: "样本图" },
            ],
            options: [
              { key: "A", label: [T("锲而不舍（qiè）")] },
              { key: "B", label: [T("强词夺理（qiáng）")] },
              { key: "C", label: [T("味同嚼蜡（jiáo）")] },
              {
                key: "D",
                label: [T("这一项特别长，超过了十四个字，按卷面口径应该自己独占一行而不是和别人挤在半边")],
              },
            ],
            answer: { keys: ["C"] },
            analysis: [T("“嚼”在“味同嚼蜡”中读 jiáo，表示像吃蜡一样没有味道。")],
          },
        },
        {
          id: "q2",
          seq: 2,
          qtype: "single_choice",
          score: 3,
          content: {
            stem: [T("导入态里图还没补，题干留着占位：[[图1]]（这一行是故意的，验占位不会让导出失败）")],
            options: [
              { key: "A", label: [T("甲")] },
              { key: "B", label: [T("乙")] },
            ],
            answer: { keys: ["A"] },
          },
        },
        {
          id: "q3",
          seq: 3,
          qtype: "single_choice",
          score: 3,
          content: {
            stem: [
              T("下面两张图都应当退化成一行说明文字，而不是拖垮整份导出："),
              { t: "media", kind: "image", key: "qbank/不存在的图.png", alt: "取不到的图" },
              { t: "media", kind: "image", key: `${ORIGIN_TOKEN}/dev-sample.webp`, alt: "webp 图" },
            ],
            options: [{ key: "A", label: [T("甲")] }],
            answer: { keys: ["A"] },
          },
        },
      ],
    },
    {
      id: "s2",
      title: "填空题",
      score_mode: "each",
      score_each: 2,
      section_score: 6,
      items: [
        {
          id: "q4",
          seq: 4,
          qtype: "fill_blank",
          score: 6,
          score_units: [2, 2, 2],
          content: {
            stem: [T("《劝学》中“青，取之于蓝，而青于蓝”一句，说明学习可以使人______。")],
            answer: { values: ["提高", "超越", "进步"] },
            analysis: [T("三个空的答案顺序可以互换，阅卷时按点给分。")],
          },
        },
        {
          id: "q5",
          seq: 5,
          qtype: "true_false",
          score: 2,
          content: { stem: [T("“人生自古谁无死，留取丹心照汗青”出自文天祥的《过零丁洋》。")], answer: { value: true } },
        },
      ],
    },
    {
      id: "s3",
      title: "材料分析题",
      score_mode: "each",
      score_each: 8,
      section_score: 16,
      items: [
        {
          id: "q6",
          seq: 6,
          qtype: "composite",
          score: 16,
          content: {
            stem: [
              T("阅读下面的材料，完成后面的题目。"),
              { t: "media", kind: "audio", key: "qbank/2026/demo.mp3", alt: "朗读音频" },
            ],
            sub: [
              {
                type: "fill_blank",
                content: { stem: [T("（1）材料中提到的“三顾茅庐”说的是______。")], answer: { values: ["刘备三次拜访诸葛亮"] } },
              },
              {
                type: "short_answer",
                content: {
                  stem: [T("（2）结合材料，谈谈你对工匠精神的理解。")],
                  answer: { samples: ["工匠精神是对产品精雕细琢、追求极致的职业态度。", "它要求从业者耐得住寂寞，在重复中打磨技艺。"] },
                },
              },
            ],
            analysis: [T("本题综合考查概括与表达能力，评分时按点给分。")],
          },
        },
      ],
    },
  ],
}

export default function DevPdfExportPage() {
  const [origin, setOrigin] = useState("")
  useEffect(() => setOrigin(window.location.origin), [])
  const snapshot = useMemo(() => withOrigin(SNAPSHOT, origin), [origin])

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-8">
      <h1 className="text-xl font-semibold">导出 PDF 自检</h1>
      <p className="text-sm text-muted-foreground">
        用写死的假数据渲染，不需要登录、不读数据库。点下面的按钮应当**真的下载到一份 PDF**：
        含中文题干、长段落（验断行）、一张真 PNG（验嵌图）、一张 webp 与一张取不到的图
        （验"单张失败退化成一行说明"）、音频块（验降级）、[[图1]] 占位（验不会让导出失败）。
        正卷不含答案，答案版含答案。
      </p>
      <div className="flex flex-wrap gap-3">
        <ExportPdfButton snapshot={snapshot} mode="paper" hint="正卷（不含答案）" />
        <ExportPdfButton snapshot={snapshot} mode="answers" hint="含答案与解析" />
      </div>
      <CorsProbe />
      <div className="rounded-lg border bg-white p-6 text-black">
        {/* 同一份数据在网页上的样子，方便和下载到的 PDF 对照 */}
        <p className="mb-3 text-xs text-black/50">对照：网页版卷面（PaperSheet）</p>
        <PaperSheet snapshot={snapshot} mode="paper" />
      </div>
    </div>
  )
}
