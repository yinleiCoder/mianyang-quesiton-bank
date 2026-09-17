// 组卷库：已入库试卷全市共享（与题库同口径，RLS 兜底只放行 published + live 的当前版本）。
// 页签「全部试卷 / 我的试卷」用 searchParams 驱动，装配全在服务端完成。
import Link from "next/link"
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperLibrary, loadMyPapers } from "@/lib/paper-workbench"
import { loadSubjectNodes } from "@/lib/reference-data"
import { indexNodes, isPaperNode } from "@/lib/subject-nodes"
import { PaperCard } from "@/components/papers/paper-card"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PlusIcon, SearchIcon, FileStackIcon } from "lucide-react"

export const metadata = { title: "组卷库" }

const PAGE_SIZE = 20

export default async function PapersPage({ searchParams }) {
  const sp = (await searchParams) ?? {}
  const tab = sp.tab === "mine" ? "mine" : "all"
  const kw = typeof sp.kw === "string" ? sp.kw : ""
  const node = typeof sp.node === "string" ? sp.node : ""
  const page = Math.max(1, Number(sp.page) || 1)

  await requireUser()
  const ctx = await getAuthContext()
  const supabase = await createClient()

  const [nodes, result] = await Promise.all([
    loadSubjectNodes(),
    tab === "mine"
      ? loadMyPapers(supabase, { limit: 100, offset: 0 })
      : loadPaperLibrary(supabase, { node: node || null, kw: kw || null, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  ])
  const { byId: nodeMap } = indexNodes(nodes)
  const papers = result.papers ?? []
  const total = result.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // 筛选口径与可建卷节点一致（含专业大类/专业——卷子可以挂在这些层，筛选按子树命中后端）
  const pickable = nodes.filter((n) => isPaperNode(n.kind))
  const qs = (patch) => {
    const p = new URLSearchParams({ tab, ...(kw ? { kw } : {}), ...(node ? { node } : {}), ...(page > 1 ? { page: String(page) } : {}), ...patch })
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k)
    const s = p.toString()
    return s ? `/papers?${s}` : "/papers"
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="组卷库"
        description={
          <>
            从题库挑选已入库的题目组成标准考试卷，设定每空分值、总分与考试时长，经{" "}
            <span className="font-medium text-foreground">教研组长 → 市级专家 → 入库</span>{" "}
            后全市共享，可查看与打印。
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border p-0.5 text-sm">
          <Link
            href={qs({ tab: "", page: "" })}
            className={`rounded-md px-3 py-1.5 ${tab === "all" ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
          >
            全部试卷
          </Link>
          {ctx.isTeacher && (
            <Link
              href={qs({ tab: "mine", page: "" })}
              className={`rounded-md px-3 py-1.5 ${tab === "mine" ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              我的试卷
            </Link>
          )}
        </div>
        {ctx.isTeacher && (
          <Button nativeButton={false} render={<Link href="/papers/new" />}>
            <PlusIcon className="size-4" /> 新建试卷
          </Button>
        )}
      </div>

      {tab === "all" && (
        <form className="flex flex-wrap items-center gap-2" action="/papers">
          <input type="hidden" name="tab" value="all" />
          <div className="relative min-w-56 flex-1">
            <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="kw" defaultValue={kw} placeholder="搜索试卷标题或考试名称" className="pl-8" />
          </div>
          <select
            name="node"
            defaultValue={node}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="">全部科目</option>
            {pickable.map((n) => (
              <option key={n.id} value={n.id}>
                {nodeMap.get(n.id)?.path ?? n.name}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline">
            筛选
          </Button>
        </form>
      )}

      {papers.length === 0 ? (
        <EmptyState
          icon={FileStackIcon}
          title={tab === "mine" ? "你还没有创建过试卷" : "组卷库里还没有试卷"}
          description={
            tab === "mine"
              ? "点「新建试卷」挑题组卷，提交后经两级审核即可入库。"
              : "换个筛选条件试试，或自己组一套卷子。"
          }
        />
      ) : (
        <div className="space-y-3">
          {papers.map((p) => (
            <PaperCard key={p.version_id} paper={p} ownerView={tab === "mine"} />
          ))}
        </div>
      )}

      {tab === "all" && pages > 1 && (
        <div className="flex items-center justify-center gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} nativeButton={false} render={<Link href={qs({ page: String(page - 1) })} />}>
            上一页
          </Button>
          <span className="tabular-nums text-muted-foreground">
            {page} / {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} nativeButton={false} render={<Link href={qs({ page: String(page + 1) })} />}>
            下一页
          </Button>
        </div>
      )}
    </div>
  )
}
