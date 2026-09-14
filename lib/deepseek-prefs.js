// 使用者本机的 DeepSeek 设置（密钥 + 模型选择），**只存在他自己的浏览器里**。
//
// 为什么放 localStorage 而不是数据库：
//   · 费用由使用者自己承担，密钥就该只属于他——存到数据库等于我们替他保管一个能花钱的凭证，
//     一旦库被读走就是真金白银的损失，还得额外做加密与权限；
//   · 放本地后，浏览器直连上游（官方 API 支持 CORS，已实测），
//     密钥连我们的服务器都不会经过。
// 代价（要在界面上说清楚）：同一台电脑的其他人能看到它；公共电脑用完请点「清除密钥」。

import { DEFAULT_MODEL } from "@/lib/deepseek"

const KEY_STORAGE = "mianyang.deepseek.key"
const MODEL_STORAGE = "mianyang.deepseek.model"

export function getDeepSeekKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ""
  } catch {
    // 隐私模式/禁用存储：拿不到就当没配，界面会引导去填写
    return ""
  }
}

/** 归一化粘贴内容：常见的三种"看起来没问题但会 401"的复制方式都在这儿修掉。 */
export function normalizeKeyInput(value) {
  return (value ?? "")
    .trim()
    .replace(/^Bearer\s+/i, "") // 从文档里连 "Authorization: Bearer sk-..." 一起复制了
    .replace(/^["'`]|["'`]$/g, "") // 连引号一起复制了
    .trim()
}

export function setDeepSeekKey(value) {
  try {
    const v = normalizeKeyInput(value)
    if (!v) localStorage.removeItem(KEY_STORAGE)
    else localStorage.setItem(KEY_STORAGE, v)
    return true
  } catch {
    return false
  }
}

export function clearDeepSeekKey() {
  return setDeepSeekKey("")
}

/** 选中的模型；没选过或存的值不认时回到默认模型。 */
export function getDeepSeekModel() {
  try {
    const v = localStorage.getItem(MODEL_STORAGE)
    return v && v.trim() ? v.trim() : DEFAULT_MODEL
  } catch {
    return DEFAULT_MODEL
  }
}

export function setDeepSeekModel(value) {
  try {
    const v = (value ?? "").trim()
    if (!v) localStorage.removeItem(MODEL_STORAGE)
    else localStorage.setItem(MODEL_STORAGE, v)
  } catch {
    // 存不进去也不影响本次使用（内存里那份仍然生效）
  }
}

/** 界面展示用：只露头尾，中间打码。 */
export function maskKey(key) {
  if (!key) return ""
  if (key.length <= 12) return "****"
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** 粗校验：DeepSeek 的密钥形如 sk-xxxx，不做严格断言（格式会变，别把合法密钥挡在门外）。 */
export function looksLikeKey(key) {
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(normalizeKeyInput(key))
}
