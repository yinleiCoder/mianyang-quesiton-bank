// 批量动作的执行器：对同一批 id 逐条调用同一个 RPC，汇总成功/失败。
//
// 为什么逐条、而不是写一个收 uuid[] 的批量 RPC：
//   · authenticated 角色的 statement_timeout 是 8s（见 0035 导入模块按 25 道分片的原因），
//     几百条塞进一个事务必然超时；
//   · 逐条还有个好处——「这一条已被别处处理/转派」只影响它自己，不连累整批。
//
// 串行不并发：本仓被 PostgREST 连接池打满坑过（PGRST003），批量动作不赶这几秒。
// call 返回 PostgREST 的 { error } 形状；error 是普通对象不是 Error，别指望 instanceof。
export async function runEachRpc(ids, call, onProgress) {
  const failed = []
  let done = 0
  for (const id of ids) {
    const { error } = await call(id)
    done += 1
    onProgress?.(done, ids.length)
    if (error) failed.push({ id, message: error.message ?? String(error) })
  }
  return { ok: ids.length - failed.length, failed }
}

// 进度节流：几百条时每条都 setState 会把整张列表重渲染几百次（页面发涩）。
// 每 step 条刷一次、最后一条必刷——肉眼已经足够连续。
export const progressReporter = (setProgress, step = 5) => (done, total) => {
  if (done === total || done % step === 0) setProgress({ done, total })
}

// 批量结果 → 一句 toast 文案。全成功就是成功，有失败就把第一条原因带出来
// （逐条列出来会刷屏；失败的行在界面上自己会说话）。
export function bulkResultMessage(label, ok, failed) {
  if (failed.length === 0) return `已${label} ${ok} 道`
  return ok > 0
    ? `已${label} ${ok} 道；${failed.length} 道未成功：${failed[0].message}`
    : `${failed.length} 道都未能${label}：${failed[0].message}`
}
