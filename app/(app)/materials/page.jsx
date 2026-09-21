// 复习资料空间：教师上传、全市共享。
//
// 「谁的视角」不另开一套页面（students/page.jsx 立下的规矩）—— 同一页按角色分叉：
// 所有人都能浏览，上传/删除/上下架的按钮只画给教师与自己上传的那几份。
// 真正的边界在 RLS 与 RPC 里，这里只是别把按钮画给不该点的人。
//
// 学生端的消费在 Flutter（mianyang_quiz/lib/ui/features/materials/），本页主要是教师用。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadSubjectNodes } from "@/lib/reference-data"
import { subtreeIdsOf } from "@/lib/subject-nodes"
import { loadMaterials, parseMaterialFilters } from "@/lib/materials"
import { PageHeader } from "@/components/page-header"
import { MaterialsManager } from "@/components/materials/materials-manager"

export const metadata = { title: "复习资料" }

const PAGE_SIZE = 24

export default async function MaterialsPage({ searchParams }) {
  const ctx = await requireUser()
  const filters = parseMaterialFilters((await searchParams) ?? {})

  const supabase = await createClient()
  const nodes = await loadSubjectNodes()

  // 选了父级节点要连它下面的资料一起给（老师挂在「信息技术」上的资料，
  // 点「计算机」时也该看得到）——与题库页的子树口径一致。
  const nodeIds = filters.node ? subtreeIdsOf(nodes ?? [], filters.node) : null

  const { rows, total, error } = await loadMaterials(supabase, {
    nodeIds,
    kind: filters.kind || null,
    keyword: filters.kw,
    mineOnly: filters.mine,
    userId: ctx.user.id,
    page: filters.page,
    pageSize: PAGE_SIZE,
  })
  // 装载失败要抛出交给错误边界，而不是渲染成空列表 —— 空列表会被读成"还没有资料"
  if (error) throw error

  return (
    <div className="space-y-4">
      <PageHeader
        title="复习资料"
        description={
          ctx.isTeacher
            ? "上传复习资料，全市学生都能查看、下载。建议把 PPT / Word 先导出成 PDF —— 只有 PDF 与图片学生能直接在线看。每份资料都会显示上传人、学校与下载次数。"
            : "全市教师共享的复习资料，可以查看与下载。"
        }
      />
      <MaterialsManager
        rows={rows ?? []}
        total={total}
        page={filters.page}
        pageSize={PAGE_SIZE}
        nodes={nodes ?? []}
        caller={{
          userId: ctx.user.id,
          isTeacher: ctx.isTeacher,
          isAdmin: ctx.isAdmin,
        }}
      />
    </div>
  )
}
