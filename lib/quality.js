// 试题质量诊断的数据加载（服务端/客户端都可引用；不 import next/cache）。
//
// 权限在 SQL 里：paper_quality_diagnostics 只允许 is_paper_grader（教师/管理员）。
// 这里把 42501 映射成 denied，页面据此决定"不显示"而不是把整页打挂。

export async function loadPaperQuality(supabase, paperId) {
  const { data, error } = await supabase.rpc("paper_quality_diagnostics", {
    p_paper_id: paperId,
  })
  if (error) return { data: null, denied: error.code === "42501", error }
  return { data, denied: false, error: null }
}
