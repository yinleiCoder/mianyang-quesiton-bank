// 删除一份复习资料（连同它在 OSS 上的对象）。
//
// 为什么单独开一条路由，而不是复用 /api/oss/delete：
// 那条是给头像用的，它的安全模型是「key 从浏览器传进来 + 正则锁死 avatars/ + 校验还被引用」，
// 而且它自己在注释里承认了残余风险（知道自己旧头像 key 的人能删掉已无人引用的对象）。
// 资料是**要长期存在的教学资产**，不能带这个洞。
//
// 这里的做法反过来：**客户端只传资料 id，object_key 全程不出服务端**。
//   ① 必须登录；
//   ② 调 delete_review_material RPC —— 归属判断（作者本人或管理员）在函数里，
//      RPC 删行后把 object_key 交回来。客户端伪造不了别人的 id 对应的 key；
//   ③ 拿到 key 才去删 OSS 对象。
//
// **顺序是先删行、后删对象**：反过来的话，一旦 OSS 删成功而行没删掉，库里就留着一行
// 指向不存在的对象（学生点开是坏链）。现在最坏情况是留个孤儿对象——用户看不见。
// 所以第 ③ 步失败**不算整体失败**：行已经删了，资料在用户眼里就是没了，
// 只回一个 cleanupFailed 让界面提示"文件清理稍后重试"，不要报"删除失败"让教师重复操作。
import { getRequestAuth } from "@/lib/api-auth"
import { ossRequestFromEnv } from "@/lib/oss-sign.mjs"

export async function POST(request) {
  try {
    return await deleteMaterial(request)
  } catch (err) {
    // 与 sign / delete 两条路由同款兜底：未预期错误也必须回 JSON，
    // 否则客户端拿到 HTML 500，解析错误体时二次崩溃。
    console.error("资料删除异常", err)
    return Response.json({ error: "服务端内部错误，请稍后重试" }, { status: 500 })
  }
}

async function deleteMaterial(request) {
  const { user, supabase } = await getRequestAuth(request)
  if (!user) {
    return Response.json({ error: "未登录或会话已过期" }, { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 })
  }
  const id = String(body?.id ?? "")
  if (!id) {
    return Response.json({ error: "缺少资料 id" }, { status: 400 })
  }

  // ① 归属判断 + 删行 + 取回 key，全在函数里完成
  const { data, error } = await supabase.rpc("delete_review_material", { p_id: id })
  if (error) {
    // 函数里的业务错误（不是作者、资料不存在）原样透出，界面直接显示这句中文
    const message = error.message || "删除失败"
    const status = /只能删除自己|不存在或已被删除/.test(message) ? 403 : 500
    if (status === 500) console.error("delete_review_material 失败", error)
    return Response.json({ error: message }, { status })
  }

  const objectKey = data?.object_key
  if (!objectKey) {
    // 行已经删了但没拿到 key——不该发生，记下来即可，别让用户以为没删掉
    console.error("删除资料未返回 object_key", id)
    return Response.json({ ok: true, deleted: true, cleanupFailed: true })
  }

  // ② 删 OSS 对象。key 来自库里的行，客户端无从伪造。
  try {
    const { url, init } = ossRequestFromEnv({ method: "DELETE", key: objectKey })
    const res = await fetch(url, init)
    // 幂等：对象已经不在了（重复调用、或之前删过）也算成功
    if (res.ok || res.status === 404) {
      return Response.json({ ok: true, deleted: true })
    }
    const detail = (await res.text().catch(() => "")).slice(0, 300)
    console.error("资料 OSS 删除失败", res.status, objectKey, detail)
  } catch (err) {
    console.error("资料 OSS 删除异常", objectKey, err)
  }

  // 行已删、对象没删掉：留了个孤儿对象。对用户而言资料已经没了，如实但不吓人地告知。
  return Response.json({ ok: true, deleted: true, cleanupFailed: true })
}
