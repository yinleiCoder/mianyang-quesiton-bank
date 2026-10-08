// 渲染检查页（fixture）：给「审批流程画布」（React Flow）过一遍真实渲染。
//
// ⚠ **不要删掉它**（2026-10-08 用户要求：删任何东西之前先问）。
//   它只渲染下面写死的假数据，不读数据库、不调上游，任何账号都能打开（不需要登录）。
//
// 为什么需要它：画布只出现在审批详情里，而那个页面要登录 + 连数据库（后端不可达时打不开）。
// 三种典型状态（卡在组长 / 被退回 / 已入库）各摆一份，改节点样式时不用去凑真实数据。
import { ApprovalFlowCanvas } from "@/components/review/approval-flow-canvas"

export const metadata = { title: "审批流程画布自检" }

const CASES = [
  {
    name: "卡在教研组长（岗位池里有两位专家，等待认领）",
    steps: [
      { id: "submit", label: "教师提交", state: "done", by: "王秀兰", at: "2026-10-07T09:12:00+08:00" },
      {
        id: "group",
        label: "教研组长审核",
        state: "current",
        assigned: "李建国、张敏",
        comment: undefined,
      },
      { id: "city", label: "市级专家审核", state: "" },
      { id: "publish", label: "入库", state: "" },
    ],
  },
  {
    name: "被市级专家退回（带意见）",
    steps: [
      { id: "submit", label: "教师提交", state: "done", by: "王秀兰", at: "2026-10-06T15:40:00+08:00" },
      {
        id: "group",
        label: "教研组长审核",
        state: "done",
        by: "李建国",
        at: "2026-10-06T17:05:00+08:00",
        comment: "题干表述清楚，同意上报。",
      },
      {
        id: "city",
        label: "市级专家审核",
        state: "halted",
        by: "陈志远",
        at: "2026-10-07T10:22:00+08:00",
        comment: "选项 C 的答案有争议，请核对教材第 42 页后重新提交。",
      },
      { id: "publish", label: "入库", state: "" },
    ],
  },
  {
    name: "已入库（组长那一行对专家不可见 → 用版本状态兜底）",
    steps: [
      { id: "submit", label: "教师提交", state: "done", by: "王秀兰", at: "2026-10-01T08:30:00+08:00" },
      { id: "group", label: "教研组长审核", state: "done", by: null, at: null, comment: undefined },
      {
        id: "city",
        label: "市级专家审核",
        state: "done",
        by: "陈志远",
        at: "2026-10-02T11:00:00+08:00",
        comment: "通过。",
      },
      { id: "publish", label: "入库", state: "done", by: "系统自动", at: "2026-10-02T11:00:05+08:00" },
    ],
  },
  {
    name: "下线申请（另一条链）",
    steps: [
      { id: "apply", label: "发起申请", state: "done", by: "王秀兰", at: "2026-10-08T08:00:00+08:00" },
      { id: "review", label: "教研组长审核", state: "current", assigned: "李建国", comment: undefined },
      { id: "effect", label: "题目下线", state: "" },
    ],
  },
]

export default function DevApprovalFlowPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-8">
      <div>
        <h1 className="text-xl font-semibold">审批流程画布自检</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          写死的假数据，不需要登录。四个状态各一份：节点依次进场、已走过的边是流动虚线、
          当前待办的节点有一圈呼吸光。画布可以拖动，右下角的控件能缩放/复位。
        </p>
      </div>
      {CASES.map((c) => (
        <section key={c.name} className="space-y-2">
          <h2 className="text-sm font-medium">{c.name}</h2>
          <ApprovalFlowCanvas steps={c.steps} />
        </section>
      ))}
    </div>
  )
}
