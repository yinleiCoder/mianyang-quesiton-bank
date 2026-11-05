"use client"

// 班均画像：把全班每个学生的六轴取平均，用来回答“这个班整体强在哪、弱在哪”。
//
// 刻意做成**按需计算**：BKT 在 36 人班上约 2–3 秒，不能塞进班级页首屏 SSR。
// 只展示班均与每轴参与人数；不展示任何学生个人值，也不用于排名。

import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { loadClassLearningProfile } from "@/lib/analytics"
import { LearningProfileChart } from "@/components/students/learning-profile-chart-lazy"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2Icon, UsersIcon } from "lucide-react"

export function ClassLearningProfileCard({ classId }) {
  const [profile, setProfile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function run() {
    setBusy(true)
    setError("")
    try {
      const supabase = createClient()
      const { profile: data, denied, error: loadError } = await loadClassLearningProfile(
        supabase,
        { classId, days: 90 }
      )
      if (denied) {
        setError("没有权限查看这个班级的画像")
        return
      }
      if (loadError || !data) {
        setError(loadError?.message || "取不到班级画像")
        return
      }
      setProfile(data)
    } catch (err) {
      setError(err.message || "计算失败")
    } finally {
      setBusy(false)
    }
  }

  const axes = profile?.axes ?? []
  const scored = axes.filter((axis) => axis.score != null)
  const canDraw = scored.length >= 5

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-base font-semibold">
            <UsersIcon className="size-4" /> 班均画像
          </span>
          <span className="text-xs text-muted-foreground">
            六轴班均 · 仅教师可见 · 不用于排名
          </span>
          <Button type="button" size="sm" className="ml-auto" onClick={run} disabled={busy}>
            {busy ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <UsersIcon className="size-3.5" />
            )}
            {profile ? "重新计算" : "查看班均画像"}
          </Button>
        </div>

        {error && <p className="text-xs text-rose-600">{error}</p>}

        {!profile && !error && (
          <p className="text-sm text-muted-foreground">
            按需计算（约 2–3 秒）：把全班每个学生达到样本门槛的轴取平均，
            用来看整体强项与短板。不展示单个学生。
          </p>
        )}

        {profile && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="font-normal">
                数据窗口 {profile.window_days} 天
              </Badge>
              <span>
                有数据的学生 {profile.students_with_data ?? 0}/
                {profile.class?.student_count ?? 0}
              </span>
            </div>

            {canDraw ? (
              <LearningProfileChart axes={axes} name="班均" />
            ) : (
              <p className="rounded-md border bg-muted/20 p-3 text-sm">
                数据还不够画雷达：至少 5 个轴有足够样本，当前 {scored.length} 个轴有分数。
              </p>
            )}

            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {axes.map((axis) => (
                <div key={axis.key} className="rounded-md border px-2 py-1.5 text-xs">
                  <span className="text-muted-foreground">{axis.label}：</span>
                  <span className="font-medium">{axis.score ?? "—"}</span>
                  <span className="ml-1 text-muted-foreground">（{axis.sample} 人）</span>
                </div>
              ))}
            </div>

            {profile.caveats?.length > 0 && (
              <ul className="rounded-md border border-amber-300 bg-amber-50/70 p-2 text-xs text-amber-900">
                {profile.caveats.map((caveat, index) => (
                  <li key={index}>· {caveat}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              雷达上的 0 表示该轴样本不足，不是学生得 0 分。
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
