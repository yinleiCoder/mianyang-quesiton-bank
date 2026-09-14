// 审计日志（系统管理员）：关键操作留痕（审批决断、上下线、转派、管理员直操作等），只读展示最近 200 条。
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import { loadAuditRows } from "@/lib/admin-records"
import { fmtDateTime } from "@/lib/format"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"

export const metadata = { title: "审计日志" }

const shortId = (s) => (s ? String(s).slice(0, 8) : "-")

export default async function AdminAuditPage() {
  const ctx = await requireUser()
  if (!ctx.isAdmin) {
    return <AccessDenied title="仅系统管理员可见" description="审计日志记录审批决断与关键管理操作，供追溯使用。" />
  }
  const supabase = await createClient()
  const rows = await loadAuditRows(supabase, { limit: 200 })

  // 出现过的动作清单（用于表头说明；页面不提供历史查询，先全量展示最近 200 条）
  const actionsSeen = [...new Set(rows.map((r) => r.actionLabel))]

  return (
    <div className="space-y-4">
      <PageHeader
        title="审计日志"
        description={
          <>
            最近 {rows.length} 条关键操作留痕：
            {actionsSeen.length > 0 ? actionsSeen.join("、") : "暂无记录"}。
            日志与业务变更同事务写入，不可篡改。
          </>
        }
      />

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
          暂无审计记录
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">操作人</th>
                <th className="px-3 py-2 font-medium">动作</th>
                <th className="px-3 py-2 font-medium">题目</th>
                <th className="px-3 py-2 font-medium">详情</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.id} className="align-top hover:bg-accent/30">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {fmtDateTime(r.createdAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{r.actorName}</td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary" className="px-1.5 py-0 text-xs">
                      {r.actionLabel}
                    </Badge>
                  </td>
                  <td className="min-w-40 px-3 py-2">
                    <p className="line-clamp-1 text-xs text-muted-foreground">
                      {r.summary || `（题目 ${shortId(r.questionId)}，无内容摘要）`}
                    </p>
                  </td>
                  <td className="max-w-72 px-3 py-2">
                    <pre className="line-clamp-2 whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                      {r.detailText}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
