// 阅卷分摊 RPC 封装（客户端）。
//
// 口径见 0148：阅卷资格按「考生所在学校 + 专业 + 该科目组长/市级专家」推导；
// 默认公共池认领，管理员可按场次分派或一键平均分配。这里只做薄封装，
// 所有校验都在服务端 RPC 里（客户端不判断自己能不能批）。
import { createClient } from "@/lib/supabase/client"

function client() {
  return createClient()
}

/** 侧栏角标：{ mine: 我认领的待批, pool: 我能认领的未认领 } */
export async function loadMyGradingPool() {
  const { data, error } = await client().rpc("count_my_grading_pool")
  if (error) return { pool: null, error }
  return { pool: data ?? { mine: 0, pool: 0 }, error: null }
}

/** 认领一场。别人已认领时服务端会带姓名报错。 */
export async function claimAttempt(attemptId) {
  const { data, error } = await client().rpc("claim_exam_grading", { p_attempt_id: attemptId })
  return { data, error }
}

/** 释放认领（认领人本人或试卷管理员）。 */
export async function releaseAttempt(attemptId) {
  const { data, error } = await client().rpc("release_exam_grading", { p_attempt_id: attemptId })
  return { data, error }
}

/** 管理员把某一场改派给某位老师。 */
export async function assignAttempt(attemptId, graderId) {
  const { data, error } = await client().rpc("assign_exam_grading", {
    p_attempt_id: attemptId,
    p_grader_id: graderId,
  })
  return { data, error }
}

/** 管理员一键平均分配该卷所有未认领场次。 */
export async function autoAssignPaper(paperId) {
  const { data, error } = await client().rpc("auto_assign_exam_grading", { p_paper_id: paperId })
  return { data, error }
}

/** 某一场的可改派老师（管理员）。 */
export async function loadAttemptCandidates(attemptId) {
  const { data, error } = await client().rpc("list_attempt_grading_candidates", {
    p_attempt_id: attemptId,
  })
  return { candidates: Array.isArray(data) ? data : [], error }
}
