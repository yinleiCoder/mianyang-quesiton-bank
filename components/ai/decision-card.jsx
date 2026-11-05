"use client"

// 可解释决策卡：把一次 AI/算法决策拆成「输入 → 方法 → 关键因素 → 置信度 → caveat → 动作」。
//
// 纯展示组件，不做任何计算；调用方把已有指标传进来。用于组卷、评分、审题、画像等
// 需要“说得清为什么”的地方。
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"

export function DecisionCard({
  title,
  decision,
  method,
  inputs = [],
  factors = [],
  confidence = null,
  caveats = [],
  actions = null,
  children = null,
}) {
  const caveatList = Array.isArray(caveats) ? caveats.filter(Boolean) : [caveats].filter(Boolean)

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="space-y-2 pt-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{title}</span>
          {method && (
            <Badge variant="secondary" className="font-normal">
              {method}
            </Badge>
          )}
          {confidence != null && (
            <span className="ml-auto text-xs text-muted-foreground">
              置信度 {Math.round(Number(confidence) * 100)}%
            </span>
          )}
        </div>

        {decision && <p>{decision}</p>}

        {inputs.length > 0 && (
          <p className="text-xs text-muted-foreground">
            输入：{inputs.filter(Boolean).join(" · ")}
          </p>
        )}

        {factors.length > 0 && (
          <ul className="grid gap-1 sm:grid-cols-2">
            {factors.map((factor, index) => (
              <li
                key={`${factor.label}-${index}`}
                className="rounded-md border bg-background/70 px-2 py-1 text-xs"
              >
                <span className="text-muted-foreground">{factor.label}：</span>
                <span className="font-medium">{factor.value}</span>
                {factor.hint && (
                  <span className="ml-1 text-muted-foreground">{factor.hint}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {children}

        {caveatList.length > 0 && (
          <ul className="rounded-md border border-amber-300 bg-amber-50/70 p-2 text-xs text-amber-900">
            {caveatList.map((caveat, index) => (
              <li key={index}>· {caveat}</li>
            ))}
          </ul>
        )}

        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </CardContent>
    </Card>
  )
}
