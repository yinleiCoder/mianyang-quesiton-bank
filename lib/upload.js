"use client"

// 浏览器端 OSS 直传（配合 app/api/oss/sign 服务端预签名）。
// 安全边界：密钥永不下发——这里只拿一次性 policy/signature，且对象 key 由服务端生成。
// question_media 上传成功后须调 register_media 登记（随草稿保存挂版本引用）；avatar 直接写 profiles.avatar_url。

export async function uploadToOSS(file, purpose) {
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

  // OSS POST 表单：policy 字段在前，file 放最后
  const fd = new FormData()
  for (const [name, value] of Object.entries(signed.fields)) fd.append(name, value)
  fd.append("file", file)
  let up
  try {
    up = await fetch(signed.uploadUrl, { method: "POST", body: fd })
  } catch {
    // 跨域请求被浏览器拦截（未配置 CORS / 来源不在白名单）时 fetch 抛 TypeError，落在这里
    throw new Error(
      "网络请求被拦截（Failed to fetch）：请检查 OSS 存储桶已开启跨域设置（CORS）并允许本站域名，配置后需刷新页面重试"
    )
  }
  if (!up.ok) {
    let detail = ""
    try {
      const xml = await up.text()
      detail = xml.match(/<Message>([\s\S]*?)<\/Message>/)?.[1]?.trim() ?? xml.slice(0, 200)
    } catch {
      // 读取失败不阻塞报错
    }
    throw new Error(`上传被 OSS 拒绝（HTTP ${up.status}）：${detail || "未知错误"}`)
  }
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
