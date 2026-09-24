import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { avatarUrl } from "@/lib/oss-url"
import { fmtDateTime24 } from "@/lib/format"
import { fmtDuration, rankTone } from "@/lib/analytics"

// 榜单表格。纯 CSS，不引 recharts——这一页全是文字与数字，扛一个 300KB 的图表库不划算
// （components/students/student-detail.jsx 的头注已经把这条教训写死了）。
//
// 三档口径共用一张表，只是"次要那一列"不同：班级榜看班级、全校/全市看学校。
// 学校名一律显示（用户明确要求"排行应标注出学校信息"）。
function Row({ row, showSchool }) {
  const name = row.name ?? "（已注销）"
  return (
    <li
      className={`flex items-center gap-3 px-3 py-2 text-sm ${
        row.is_me ? "rounded-lg bg-primary/5 ring-1 ring-primary/30" : ""
      }`}
    >
      <span
        className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ring-1 ${rankTone(
          Number(row.rank)
        )}`}
      >
        {row.rank}
      </span>
      <Avatar className="size-7 shrink-0 rounded-md">
        {row.avatar_url && <AvatarImage src={avatarUrl(row.avatar_url)} alt={name} />}
        <AvatarFallback className="rounded-md text-xs">{name.slice(0, 1)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{name}</span>
        {row.is_me && <span className="ml-1 text-xs text-primary">（我）</span>}
      </span>
      <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
        {showSchool ? row.school_name : row.class_name || row.school_name}
      </span>
      <span className="w-24 shrink-0 text-right tabular-nums">
        <b className="font-medium">{Number(row.score)}</b>
        <span className="text-muted-foreground">/{Number(row.full_score)}</span>
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
        {fmtDuration(row.duration_ms) || "—"}
      </span>
      <span className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground tabular-nums lg:block">
        {fmtDateTime24(row.submitted_at)}
      </span>
    </li>
  )
}

export function LeaderboardTable({ board }) {
  const rows = board?.rows ?? []
  const showSchool = (board?.scope?.key ?? "class") !== "class"

  // 我不在前 N（榜单被 limit 截断）时，把"我"和左右各一名的 nearBy 补在表尾，
  // 否则第 204 名的人从头翻到尾也找不到自己。
  const mine = board?.viewer?.user_id
  const inRows = rows.some((r) => r.user_id === mine)
  const nearby = inRows ? [] : (board?.nearby ?? [])

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
        这个范围里还没有成绩——交卷并出分后就会出现在这里。
      </p>
    )
  }

  return (
    <div className="rounded-xl border">
      <div className="flex items-center gap-3 border-b px-3 py-2 text-xs text-muted-foreground">
        <span className="w-7 shrink-0 text-center">名次</span>
        <span className="w-7 shrink-0" />
        <span className="min-w-0 flex-1">学生</span>
        <span className="hidden min-w-0 flex-1 sm:block">{showSchool ? "学校" : "班级"}</span>
        <span className="w-24 shrink-0 text-right">得分</span>
        <span className="hidden w-16 shrink-0 text-right sm:block">用时</span>
        <span className="hidden w-28 shrink-0 text-right lg:block">交卷时间</span>
      </div>
      <ul className="divide-y">
        {rows.map((row) => (
          <Row key={row.user_id} row={row} showSchool={showSchool} />
        ))}
      </ul>

      {nearby.length > 0 && (
        <>
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            以下是你在榜上的附近位置
          </p>
          <ul className="divide-y">
            {nearby.map((row) => (
              <Row key={row.user_id} row={row} showSchool={showSchool} />
            ))}
          </ul>
        </>
      )}

      {board?.truncated && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          只显示前 {board.limit} 名（共 {board.stats?.total} 人）
        </p>
      )}
    </div>
  )
}
