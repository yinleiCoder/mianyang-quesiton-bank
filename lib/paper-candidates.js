// 智能组卷的数据加载（客户端）。
//
// 候选池走只读 RPC paper_ai_candidates：它只返回组卷需要的紧凑特征，不返回
// 题干全文/选项/答案。选中方案后再按 version_id 取完整 content，交给
// itemFromBank 变成编辑器题项；取 content 的过滤条件与 question-picker 一致
// （published + question.state=live），避免把刚下线/换版的题带进卷面。

export async function loadPaperAiCandidates(supabase, spec) {
  const { data, error } = await supabase.rpc("paper_ai_candidates", { p_spec: spec })
  if (error) return { data: null, error }
  return { data: data ?? { items: [], pool_size: 0 }, error: null }
}

const CHUNK = 100

export async function loadVersionRows(supabase, versionIds) {
  const ids = [...new Set(versionIds ?? [])].filter(Boolean)
  const rows = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from("question_versions")
      .select(
        "id, question_id, qtype, difficulty, content, published_at, question:questions!question_versions_question_id_fkey!inner(course_node_id, state)"
      )
      .in("id", chunk)
      .eq("status", "published")
      .eq("question.state", "live")
    if (error) return { data: null, error }
    rows.push(...(data ?? []))
  }
  return { data: rows, error: null }
}
