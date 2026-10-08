// 班级 AI 分析的取数（0088 的三条 RPC）。与 lib/analytics.js 同一套写法：
// 失败返回 null 而不是空对象 —— null = "这次没查成"，{} = "查成了，就是没有"。
//
// 权限不在这一层：三条 RPC 都是 SECURITY DEFINER，can_view_class 在 SQL 里过
// （与班级学情看板同一条门禁）。客户端拿到什么，是 SQL 决定发什么。
//
// ⚠ 会被 "use client" 组件引用（生成按钮就在浏览器里跑），**绝不能 import next/cache**。

/** 报告 + 当前指纹（页面加载用）。denied / missing 分开返回，页面据此说不同的话。 */
export async function loadClassAiReport(supabase, { paperId, classId }) {
  const { data, error } = await supabase.rpc("class_ai_report", {
    p_paper_id: paperId,
    p_class_id: classId,
  })
  if (error) return { data: null, denied: error.code === "42501", error }
  return { data, denied: false, error: null }
}

/**
 * 喂给模型的那份数据（点"生成"时才取，比报告重得多）。
 * 返回 { fingerprint, payload }：**生成前后都要带着这个 fingerprint** ——
 * 存回时必须原样交回，服务端拿它核对"你这份结论对应的是不是现在的学情"。
 */
export async function loadClassAiPayload(supabase, { paperId, classId }) {
  const { data, error } = await supabase.rpc("class_ai_payload", {
    p_paper_id: paperId,
    p_class_id: classId,
  })
  if (error) return { data: null, denied: error.code === "42501", error }
  return { data, denied: false, error: null }
}

/**
 * 存结果。`stale`（40001）= 生成期间又有人交卷/判分，这份结论对应的已经不是现在的学情，
 * 服务端会拒收 —— 页面要提示"数据变了，请重新生成"，而不是把错误当成网络故障。
 */
export async function saveClassAiReport(supabase, { paperId, classId, fingerprint, content, model }) {
  const { data, error } = await supabase.rpc("save_class_ai_report", {
    p_paper_id: paperId,
    p_class_id: classId,
    p_fingerprint: fingerprint,
    p_content: content,
    p_model: model || null,
  })
  if (error) {
    return {
      id: null,
      denied: error.code === "42501",
      stale: error.code === "40001",
      error,
    }
  }
  return { id: data, denied: false, stale: false, error: null }
}
