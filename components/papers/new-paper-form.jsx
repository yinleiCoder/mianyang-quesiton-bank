"use client"

// 建卷表单：只收卷头与科目节点，卷面留给编辑器。
// 先建空卷再进编辑器，而不是在弹窗里一次收完——组卷是长任务，
// 建完立刻能看到卷面结构（大题、分值、合计），比对着表单空想更实在。
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function NewPaperForm({ nodes }) {
  const router = useRouter()
  const supabase = createClient()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    course_node_id: "",
    title: "",
    exam_name: "",
    subject_label: "",
    duration_minutes: 90,
    target_score: "",
  })

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    if (!form.course_node_id) {
      toast.error("请先选择科目")
      return
    }
    if (!form.title.trim()) {
      toast.error("请填写试卷标题")
      return
    }
    setBusy(true)
    const { data: versionId, error } = await supabase.rpc("create_paper_draft", {
      p_course_node: form.course_node_id,
      p_meta: {
        title: form.title.trim(),
        exam_name: form.exam_name.trim(),
        subject_label: form.subject_label.trim(),
        duration_minutes: Number(form.duration_minutes) || 90,
        target_score: form.target_score === "" ? null : Number(form.target_score),
      },
    })
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success("试卷已创建，开始挑题吧")
    router.push(`/papers/edit/${versionId}`)
  }

  return (
    <form onSubmit={submit} className="max-w-xl space-y-4">
      <div>
        <Label htmlFor="paper-node">科目</Label>
        <select
          id="paper-node"
          value={form.course_node_id}
          onChange={set("course_node_id")}
          className="mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">请选择（决定审核走哪个教研组长与市级专家）</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.path ?? n.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-muted-foreground">
          只能挂在公共学科或专业课程层；审核人按这个节点自动指派。
        </p>
      </div>

      <div>
        <Label htmlFor="paper-title">试卷标题</Label>
        <Input
          id="paper-title"
          value={form.title}
          onChange={set("title")}
          className="mt-1"
          placeholder="如：计算机类模拟卷（一）"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="paper-exam-name">考试名称</Label>
          <Input
            id="paper-exam-name"
            value={form.exam_name}
            onChange={set("exam_name")}
            className="mt-1"
            placeholder="四川省2024年高职教育单招"
          />
        </div>
        <div>
          <Label htmlFor="paper-subject-label">科目名（卷面用）</Label>
          <Input
            id="paper-subject-label"
            value={form.subject_label}
            onChange={set("subject_label")}
            className="mt-1"
            placeholder="计算机类试题"
          />
        </div>
        <div>
          <Label htmlFor="paper-duration">考试时长（分钟）</Label>
          <Input
            id="paper-duration"
            type="number"
            min="1"
            max="600"
            value={form.duration_minutes}
            onChange={set("duration_minutes")}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="paper-target">设定总分</Label>
          <Input
            id="paper-target"
            type="number"
            min="0"
            step="0.5"
            value={form.target_score}
            onChange={set("target_score")}
            className="mt-1"
            placeholder="可留空，之后在编辑器里填"
          />
          <p className="mt-1 text-xs text-muted-foreground">提交时会校验卷面合计是否等于它。</p>
        </div>
      </div>

      <Button type="submit" disabled={busy}>
        {busy ? "创建中…" : "创建并开始组卷"}
      </Button>
    </form>
  )
}
