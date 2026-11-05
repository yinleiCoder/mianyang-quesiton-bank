// 讲评教案的取数/存数（0123 的两个只读/写入 RPC）。
//
// 与 lib/class-ai.js 同一条写法：denied / stale 分开返回，页面据此说不同的话；
// 不要把 PostgREST 的原始错误直接扔给用户。

export async function loadClassLessonPlan(supabase, { paperId, classId }) {
  const { data, error } = await supabase.rpc("class_lesson_plan", {
    p_paper_id: paperId,
    p_class_id: classId,
  })
  if (error) return { data: null, denied: error.code === "42501", error }
  return { data, denied: false, error: null }
}

export async function saveClassLessonPlan(
  supabase,
  { paperId, classId, fingerprint, content, model = null }
) {
  const { data, error } = await supabase.rpc("save_class_lesson_plan", {
    p_paper_id: paperId,
    p_class_id: classId,
    p_fingerprint: fingerprint,
    p_content: content,
    p_model: model,
  })
  if (error) {
    return {
      id: null,
      denied: error.code === "42501",
      stale: error.code === "PT409",
      error,
    }
  }
  return { id: data, denied: false, stale: false, error: null }
}
