// 组卷库：已入库试卷全市共享（与题库同口径，RLS 兜底只放行 published + live 的当前版本）。
// 页签「全部试卷 / 我的试卷 / 我参与的」用 searchParams 驱动，装配全在服务端完成。
// 「我参与的」（0085 协同组卷）是**子卷任务**列表，不是卷子列表 —— 一行一段，
// 点进去到片段编辑器（/papers/assign/[id]）。
import Link from "next/link"
import { requireUser, getAuthContext } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadPaperLibrary, loadMyPapers } from "@/lib/paper-workbench"
import { loadMyAssignments, loadMyTaskCount, assignmentStateChip, spanLabel } from "@/lib/paper-assignments"
import { loadSubjectNodes } from "@/lib/reference-data"
import { indexNodes, isPaperNode } from "@/lib/subject-nodes"
import { PaperCard } from "@/components/papers/paper-card"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PlusIcon, SearchIcon, FileStackIcon, ClipboardListIcon } from "lucide-react"

export const metadata = { title: "组卷库" }

const PAGE_SIZE = 20

export default async function PapersPage({ searchParams }) {
  const sp = (await searchParams) ?? {}
  const tab = sp.tab === "mine" ? "mine" : sp.tab === "assigned" ? "assigned" : "all"
  const kw = typeof sp.kw === "string" ? sp.kw : ""
  const node = typeof sp.node === "string" ? sp.node : ""
  const page = Math.max(1, Number(sp.page) || 1)

  await requireUser()
  const ctx = await getAuthContext()
  const supabase = await createClient()

  const [nodes, result, myTasks, taskCount] = await Promise.all([
    loadSubjectNodes(),
    tab === "assigned"
      ? Promise.resolve({ papers: [], total: 0 })
      : tab === "mine"
        ? loadMyPapers(supabase, { limit: 100, offset: 0 })
        : loadPaperLibrary(supabase, { node: node || null, kw: kw || null, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    tab === "assigned" ? loadMyAssignments(supabase, { limit: 100 }) : Promise.resolve({ rows: [], total: 0 }),
    // 页签上标条数：角标把人引到这一页，页签再告诉他去哪 —— 少一次「点进去发现没有」。
    // 计数失败退回 0（与侧栏角标同一口径：装饰性信息不阻断页面）
    ctx.isTeacher ? loadMyTaskCount(supabase).catch(() => 0) : Promise.resolve(0),
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
          {ctx.isTeacher && (
            <Link
              href={qs({ tab: "assigned", page: "" })}
              className={`rounded-md px-3 py-1.5 ${tab === "assigned" ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              我参与的{taskCount > 0 ? ` · ${taskCount}` : ""}
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

      {tab === "assigned" ? (
        myTasks.rows.length === 0 ? (
          <EmptyState
            icon={ClipboardListIcon}
            title="还没有分给你的子卷任务"
            description="创始人组卷时可以把某大题的一段题号分给其他老师 —— 分到之后，你会在这里看到它。"
          />
        ) : (
          <div className="space-y-3">
            {myTasks.rows.map((a) => {
              const chip = assignmentStateChip(a.state)
              const open = a.state === "open" || a.state === "claimed"
              const cap = a.to_qno - a.from_qno + 1
              return (
                <div
                  key={a.assignment_id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card p-4"
                >
                  <span className={`rounded px-1.5 py-0.5 text-xs ${chip.cls}`}>{chip.text}</span>
                  <span className="font-medium">{a.paper_title || "（未命名试卷）"}</span>
                  <span className="text-sm text-muted-foreground">{spanLabel(a)}</span>
                  <Badge variant="outline" className="text-xs">
                    已挑 {Number(a.item_count)}/{cap} 题 · 目标 {Number(a.score ?? 0)} 分
                  </Badge>
                  {a.version_status !== "draft" && a.version_status !== "returned" && (
                    <span className="text-xs text-amber-600">卷子已提交/入库，只读</span>
                  )}
                  <Button
                    variant={open ? "default" : "outline"}
                    size="sm"
                    className="ml-auto"
                    nativeButton={false}
                    render={<Link href={`/papers/assign/${a.assignment_id}`} />}
                  >
                    {open ? "去挑题" : "查看"}
                  </Button>
                </div>
              )
            })}
          </div>
        )
      ) : papers.length === 0 ? (
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
