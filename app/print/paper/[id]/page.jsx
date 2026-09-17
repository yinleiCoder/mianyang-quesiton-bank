// 试卷正卷打印页：干净的一页纸，供浏览器「打印 → 另存为 PDF」。
//
// 与题目打印页同一个取舍：不服务端生成 PDF——中文排版要嵌字体、公式/图片/表格
// 都得逐个实现，而浏览器自带的打印引擎这些全都现成。
//
// **答案不在这个路由里**。正卷与参考答案分为两个页面不是排版偏好而是安全边界：
// 靠 print:hidden 藏起来的 DOM 仍可从源码里看到、复制、打印，等于把答案随卷发给学生。
//
// 不进 (app) 路由组：那边有侧栏与页头，打印时会一起印出来。
// 仍然 requireUser()：草稿卷只该给作者与审批人看，可见性由 get_paper_version 断言。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperVersion } from "@/lib/paper-workbench"
import { PaperSheet } from "@/components/papers/paper-sheet"
import { PrintButton } from "@/components/print-button"
import { AccessDenied } from "@/components/access-denied"

export const metadata = { title: "打印试卷" }

export default async function PrintPaperPage({ params }) {
  const { id } = await params
  await requireUser()
  const supabase = await createClient()

  let snapshot = null
  try {
    snapshot = await loadPaperVersion(supabase, id)
  } catch {
    // 不可见（别人的草稿/在审卷）与不存在走同一个出口：不透露"存在但你没权限"
    snapshot = null
  }
  if (!snapshot) {
    return (
      <AccessDenied
        title="试卷不可见"
        description="这份试卷可能正在审核中、已被撤回，或不属于你，因此不能打印。"
      />
    )
  }

  return (
    <div className="mx-auto max-w-[820px] bg-white p-8 text-black print:p-0">
      <PrintButton hint="在打印对话框里选「另存为 PDF」即可保存；参考答案请用「打印答案」" />
      <PaperSheet snapshot={snapshot} mode="paper" />
      <footer className="mt-8 border-t border-black/20 pt-2 text-[10px] text-black/50">
        绵阳市中职共建题库 · 本卷题目均取自全市共建题库，经两级审核入库
      </footer>
    </div>
  )
}
