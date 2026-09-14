// 全市题库：跨校共享的已入库题目浏览/检索页。只呈现 state=live 且已入库（published）的当前版本，
// 草稿/审核中/下线题一律不可见（RLS 兜底，此处显式过滤）。筛选/分页经 searchParams 驱动，
// 全部装配在服务端完成；卡片点击进入 /bank/[id] 详情。
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { contentSummary, qtypeLabel, difficultyLabel } from "@/lib/question-model"
import { subjectNodesQuery, indexNodes, subtreeIdsOf } from "@/lib/subject-nodes"
import { bankQueryString, hasBankFilters, parseBankFilters } from "@/lib/bank-query"
import { fmtDate } from "@/lib/format"
import { loadPeople } from "@/lib/people"
import { PersonChip } from "@/components/bank/person-chip"
import { BankFilters } from "@/components/bank/bank-filters"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, FileQuestionIcon } from "lucide-react"

export const metadata = { title: "全市题库" }

const PAGE_SIZE = 10

// LIKE 通配符转义，让关键词里的 %/_ 按字面匹配
const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

export default async function BankPage({ searchParams }) {
  const { kw, qtype, diff, node, tag, page } = parseBankFilters((await searchParams) ?? {})

  await requireUser()
  const supabase = await createClient()

  // 筛选控件/节点路径所需的共享字典
  const [nodesRes, tagsRes] = await Promise.all([
    subjectNodesQuery(supabase, { sorted: true }),
    supabase.from("tags").select("id, name").order("name"),
  ])
  const nodes = nodesRes.data ?? []
  const tags = tagsRes.data ?? []
  const { byId: nodeMap, pathOf: nodePath } = indexNodes(nodes)

  // 科目筛选 = 所选节点及其全部后代（题库挂在学科/课程这类可挂节点上）
  const subtreeIds = node ? (nodeMap.has(node) ? subtreeIdsOf(nodes, node) : []) : null

  // 标签筛选先解析出命中版本集合（多对多，postgREST 无法在过滤层直接 join）
  let tagVersionIds = null
  if (tag) {
    const vtRes = await supabase
      .from("version_tags")
      .select("version_id")
      .eq("tag_id", tag)
    tagVersionIds = new Set((vtRes.data ?? []).map((v) => v.version_id))
  }

  const shortCircuit = (subtreeIds?.length === 0) || (tagVersionIds?.size === 0)

  let versionRows = []
  let count = 0
  if (!shortCircuit) {
    let b = supabase
      .from("question_versions")
      .select(
        "id, question_id, version_no, qtype, difficulty, content, published_at, created_by, question:questions!question_versions_question_id_fkey!inner(id, school_id, course_node_id, state)",
        { count: "exact" }
      )
      .eq("status", "published")
      .eq("question.state", "live")
      .order("published_at", { ascending: false })
    if (qtype) b = b.eq("qtype", qtype)
    if (diff) b = b.eq("difficulty", Number(diff))
    if (kw) b = b.ilike("search_text", `%${escapeLike(kw)}%`)
    if (subtreeIds) b = b.in("question.course_node_id", subtreeIds)
    if (tagVersionIds) b = b.in("id", [...tagVersionIds])
    const res = await b.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    if (res.error) throw res.error
    versionRows = res.data ?? []
    count = res.count ?? 0
  }

  // 行装配所需的字典：学校 / 该页版本的标签 / 当前版本的两级审核通过记录
  const versionIds = versionRows.map((v) => v.id)
  const schoolIds = [...new Set(versionRows.map((v) => v.question?.school_id).filter(Boolean))]
  const creatorIds = [...new Set(versionRows.map((v) => v.created_by).filter(Boolean))]
  const empty = Promise.resolve({ data: [] })
  const [schoolRes, rowTagRes, apprRes] = await Promise.all([
    schoolIds.length ? supabase.from("schools").select("id, name").in("id", schoolIds) : empty,
    versionIds.length
      ? supabase.from("version_tags").select("version_id, tag_name").in("version_id", versionIds)
      : empty,
    versionIds.length ? supabase.rpc("bank_reviewers", { p_version_ids: versionIds }) : empty,
  ])
  const schoolMap = new Map((schoolRes.data ?? []).map((s) => [s.id, s.name]))

  // 人物资料快照（作者 + 两级审核通过人）：列表 chips 与点击浮层共用
  const approverUids = [...new Set((apprRes.data ?? []).map((a) => a.decided_by).filter(Boolean))]
  const peopleMap = await loadPeople(supabase, [...creatorIds, ...approverUids])

  const approversByVersion = new Map()
  for (const a of apprRes.data ?? []) {
    if (!a.decided_by) continue
    const arr = approversByVersion.get(a.version_id) ?? []
    arr.push(a)
    approversByVersion.set(a.version_id, arr)
  }

  const tagsByVersion = new Map()
  for (const t of rowTagRes.data ?? []) {
    const arr = tagsByVersion.get(t.version_id) ?? []
    arr.push(t.tag_name)
    tagsByVersion.set(t.version_id, arr)
  }

  const rows = versionRows.map((v) => {
    const q = v.question
    const content = v.content ?? {}
    const subs = Array.isArray(content.sub) ? content.sub.length : 0
    // chips：作者 + 该版本两级审核通过人（作者已注销时 person=null → 渲染"作者 已注销"占位）
    const chips = []
    chips.push({ key: "author", caption: "作者", person: v.created_by ? (peopleMap.get(v.created_by) ?? null) : null })
    for (const [i, a] of (approversByVersion.get(v.id) ?? []).entries()) {
      const p = peopleMap.get(a.decided_by)
      if (p) chips.push({ key: `rev-${i}`, caption: a.stage === "group" ? "组长" : "专家", person: p })
    }
    return {
      questionId: q.id,
      href: `/bank/${q.id}`,
      qtype: v.qtype,
      qtypeLabel: qtypeLabel(v.qtype),
      difficultyLabel: v.difficulty != null ? difficultyLabel(v.difficulty) : "",
      versionNo: v.version_no,
      date: fmtDate(v.published_at),
      summary: contentSummary(content),
      nodePath: nodePath(q.course_node_id),
      schoolName: schoolMap.get(q.school_id) ?? "",
      chips,
      subs,
      tags: tagsByVersion.get(v.id) ?? [],
    }
  })

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE))
  const filterValue = { kw, node, qtype, diff, tag }
  const hasFilters = hasBankFilters(filterValue)

  function pageHref(p) {
    const qs = bankQueryString(filterValue, p)
    return qs ? `/bank?${qs}` : "/bank"
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="全市题库"
        description="全市共建共享：各校经两级审核入库的题目在此跨校浏览，可按科目、题型、难度与知识点标签筛选，或直接按题干关键词搜索。"
      />

      <BankFilters nodes={nodes} tags={tags} value={filterValue} />

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <p>
          {shortCircuit ? (
            "没有符合条件的题目"
          ) : (
            <>
              共 <span className="font-medium text-foreground">{count.toLocaleString("zh-CN")}</span> 道已入库题目
              {hasFilters && "（已按筛选条件过滤）"}
            </>
          )}
        </p>
        {hasFilters && count > 0 && (
          <Link href="/bank" className="text-xs underline-offset-2 hover:underline">
            查看全部
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={FileQuestionIcon}
          title={shortCircuit || hasFilters ? "没有符合条件的题目" : "题库还是空的"}
          description={
            shortCircuit || hasFilters
              ? "试试放宽筛选条件，或清除关键词后重新搜索。"
              : "各校教师提交并经两级审核入库后，题目会陆续出现在这里。"
          }
          action={
            hasFilters ? (
              <Link
                href="/bank"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-sm hover:bg-accent"
              >
                清除筛选
              </Link>
            ) : null
          }
        />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Link
              key={r.questionId}
              href={r.href}
              className="group block rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/30"
            >
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="outline" className="px-1.5 py-0 text-xs">
                  {r.qtypeLabel}
                </Badge>
                <span>难度 {r.difficultyLabel}</span>
                {r.subs > 0 && <span>含 {r.subs} 道子题</span>}
                <span className="text-muted-foreground/60">v{r.versionNo}</span>
                <span className="ml-auto inline-flex items-center gap-1">
                  入库 {r.date}
                  <ChevronRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-sm text-foreground/90">
                {r.summary || <span className="text-muted-foreground">（题干为空）</span>}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="truncate">{r.nodePath || "未选节点"}</span>
                {r.schoolName && <span>题源：{r.schoolName}</span>}
                {r.chips.map((c) => (
                  <PersonChip key={c.key} person={c.person} caption={c.caption} />
                ))}
                {r.tags.length > 0 && (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {r.tags.slice(0, 3).map((t, i) => (
                      <Badge key={i} variant="secondary" className="px-1.5 py-0 text-xs">
                        {t}
                      </Badge>
                    ))}
                    {r.tags.length > 3 && <span className="text-muted-foreground/70">+{r.tags.length - 3}</span>}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {rows.length > 0 && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-1">
          {page > 1 ? (
            <Link
              href={pageHref(page - 1)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-sm hover:bg-accent"
            >
              <ChevronLeftIcon className="size-4" /> 上一页
            </Link>
          ) : (
            <span className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input px-3 text-sm text-muted-foreground/60">
              <ChevronLeftIcon className="size-4" /> 上一页
            </span>
          )}
          <span className="px-2 text-sm text-muted-foreground">
            第 {page} / {totalPages} 页
          </span>
          {page < totalPages ? (
            <Link
              href={pageHref(page + 1)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-sm hover:bg-accent"
            >
              下一页 <ChevronRightIcon className="size-4" />
            </Link>
          ) : (
            <span className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input px-3 text-sm text-muted-foreground/60">
              下一页 <ChevronRightIcon className="size-4" />
            </span>
          )}
        </div>
      )}

      <p className="flex items-center gap-1.5 pt-2 text-xs text-muted-foreground/70">
        <BookOpenIcon className="size-3.5" />
        审批中的改版不影响在线版本：新版本入库后自动替换，无需手动刷新。
      </p>
    </div>
  )
}
