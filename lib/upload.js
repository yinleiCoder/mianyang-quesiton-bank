"use client"

// 浏览器端 OSS 直传（配合 app/api/oss/sign 服务端预签名）。
// 安全边界：密钥永不下发——这里只拿一次性 policy/signature，且对象 key 由服务端生成。
// question_media 上传成功后须调 register_media 登记（随草稿保存挂版本引用）；avatar 直接写 profiles.avatar_url；
// material 上传成功后调 create_review_material 落库。
//
// **上传那一步用 XMLHttpRequest，不是 fetch。** 原因只有一个但绕不开：fetch 没有上传进度
// 事件（这是它的固有限制，不是用法问题）。而资料的文档档放宽到 2GB 之后，一次上传要几分钟，
// 没有进度条用户会以为卡死然后刷新页面——白传。签名那一步仍用 fetch：它是几十字节的小请求，
// 不需要进度，也没必要为它多写一套 XHR。

/**
 * 上传一个文件到 OSS，返回它的元信息。
 *
 * [onProgress] 形如 (loaded, total) => void，**只在上传阶段回调**（签名阶段不报）。
 * total 为 0 或拿不到时不会回调——调用方据此显示"不确定进度"而不是一个假的百分比。
 */
export async function uploadToOSS(file, purpose, { onProgress } = {}) {
  const res = await fetch("/api/oss/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose, contentType: file.type, size: file.size }),
  })
  let signed = null
  try {
    signed = await res.json()
  } catch {
    // 非 JSON 错误体，走下面的兜底文案
  }
  if (!res.ok || !signed?.uploadUrl || !signed?.fields) {
    throw new Error(signed?.error ?? `签名失败（HTTP ${res.status}）`)
  }

  await postToOss(signed, file, onProgress)

  return {
    key: signed.fields.key,
    bucket: signed.bucket,
    size: file.size,
    mime: file.type,
    // kind 落内容块：image/audio/video 各自内联渲染，其余文档附件统一为 file
    kind: file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("audio/")
        ? "audio"
        : file.type.startsWith("video/")
          ? "video"
          : "file",
  }
}

/** 真正把文件 POST 上去。返回 Promise；进度经 [onProgress] 回调。 */
function postToOss(signed, file, onProgress) {
  return new Promise((resolve, reject) => {
    // OSS POST 表单：policy 字段在前，file 放最后
    const fd = new FormData()
    for (const [name, value] of Object.entries(signed.fields)) fd.append(name, value)
    fd.append("file", file)

    const xhr = new XMLHttpRequest()
    xhr.open("POST", signed.uploadUrl)

    // 浏览器把整份 body 发完之后才触发 load；progress 是"已交给网络层"的字节数。
    // 对超大文件它与"服务端已收完"有出入，但作为进度指示足够，且是浏览器能给的唯一口径。
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded, event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // 收尾补一次 100%：某些浏览器最后一次 progress 会差几个字节
        onProgress?.(file.size, file.size)
        resolve()
        return
      }
      reject(new Error(`上传被 OSS 拒绝（HTTP ${xhr.status}）：${ossMessage(xhr.responseText)}`))
    }
    // 跨域请求被浏览器拦截（未配置 CORS / 来源不在白名单）时走这里，与 fetch 抛 TypeError 是同一件事
    xhr.onerror = () =>
      reject(
        new Error(
          "网络请求被拦截（Failed to fetch）：请检查 OSS 存储桶已开启跨域设置（CORS）并允许本站域名，配置后需刷新页面重试"
        )
      )
    // 断网/切网时触发；**不设 xhr.timeout**——2GB 的文件在慢网络下传很久是正常的，
    // 设一个超时只会把正常的大文件上传掐断。
    xhr.onabort = () => reject(new Error("上传已取消"))

    xhr.send(fd)
  })
}

/** 从 OSS 的 XML 错误体里抠出 <Message>，抠不到就截前 200 字。 */
function ossMessage(body) {
  if (!body) return "未知错误"
  return body.match(/<Message>([\s\S]*?)<\/Message>/)?.[1]?.trim() ?? body.slice(0, 200)
}

/**
 * 删除 OSS 对象（目前只用于头像：更换/移除后清理旧文件）。
 *
 * 语义是「尽力而为」：**返回结果对象而不抛错**，调用方只需决定要不要提示。
 * 之所以不抛，是因为它总是在「别的事情已经成功」之后被调用——删除失败绝不能
 * 让调用方看起来像是主流程失败了。
 */
export async function deleteOssObject(key) {
  try {
    const res = await fetch("/api/oss/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      // 用户保存后立刻跳转/关页时，也尽量把这个请求发出去
      keepalive: true,
    })
    const data = await res.json().catch(() => null)
    return { ok: res.ok, error: data?.error ?? (res.ok ? "" : `HTTP ${res.status}`) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
