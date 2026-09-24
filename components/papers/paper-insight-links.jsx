import Link from "next/link"
import { Button } from "@/components/ui/button"
import { BarChart3Icon, MonitorPlayIcon, TrophyIcon } from "lucide-react"

// 试卷详情页的三个「成绩」入口。单独成文件，不再往页面头部的按钮行里堆条件渲染
// （那一块已经同时管着阅卷 / 打印 / 打印答案三种角色分支）。
//
// 只在已入库的版本上出现：草稿与审核中的卷子没有成绩可言（两个 RPC 也会拒）。
// **权限不在这些按钮上**：能不能看某个班的榜、能不能看试题分析（学生要已出分）、
// 能不能讲评（要教师），都由 SQL 与页面自己的角色闸决定；这里只是不给一个点了会被拒的入口
// （与「阅卷」同一个做法）。讲评模式额外只给教师看：它是投屏给全班用的。
export function PaperInsightLinks({ paperId, published, canLecture }) {
  if (!published) return null
  return (
    <>
      <Button
        variant="outline"
        nativeButton={false}
        render={<Link href={`/papers/${paperId}/board`} />}
      >
        <TrophyIcon className="size-4" /> 成绩排行
      </Button>
      <Button
        variant="outline"
        nativeButton={false}
        render={<Link href={`/papers/${paperId}/board?tab=questions`} />}
      >
        <BarChart3Icon className="size-4" /> 试题分析
      </Button>
      {canLecture && (
        <Button
          variant="outline"
          nativeButton={false}
          // 新标签页打开：讲评是投屏，别把老师的组卷页顶掉
          render={<a href={`/lecture/paper/${paperId}`} target="_blank" rel="noreferrer" />}
        >
          <MonitorPlayIcon className="size-4" /> 讲评模式
        </Button>
      )}
    </>
  )
}
