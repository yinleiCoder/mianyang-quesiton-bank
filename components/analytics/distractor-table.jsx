// 干扰项分析表：选项、选中人数、占比、高/低分组占比、D。
// D = 高分组选中率 - 低分组选中率；正确项 D 应为正，干扰项 D 大说明它太有吸引力。
import { pctText } from "@/lib/ctt"

export function DistractorTable({ options, nGroup }) {
  if (!options?.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th className="py-1 pr-2 text-left font-medium">选项</th>
            <th className="py-1 pr-2 text-left font-medium">内容</th>
            <th className="py-1 pr-2 text-right font-medium">选中</th>
            <th className="py-1 pr-2 text-right font-medium">占比</th>
            <th className="py-1 pr-2 text-right font-medium">高分组</th>
            <th className="py-1 pr-2 text-right font-medium">低分组</th>
            <th className="py-1 text-right font-medium">D</th>
          </tr>
        </thead>
        <tbody>
          {options.map((option) => (
            <tr key={option.key} className="border-b last:border-0">
              <td className="py-1 pr-2 font-medium">
                {option.is_key ? `${option.key} ✓` : option.key}
              </td>
              <td className="max-w-[16rem] truncate py-1 pr-2" title={option.text}>
                {option.text}
              </td>
              <td className="py-1 pr-2 text-right tabular-nums">{option.count}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{pctText(option.pct)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{pctText(option.upper_pct)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{pctText(option.lower_pct)}</td>
              <td
                className={`py-1 text-right tabular-nums ${
                  option.d != null && option.d < 0 ? "text-rose-600" : ""
                }`}
              >
                {option.d == null ? "—" : option.d.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-muted-foreground">
        高/低分组各取约 27%（本卷 {nGroup} 人）；D = 高分组选中率 − 低分组选中率。
      </p>
    </div>
  )
}
