// 手机号 ↔「合成邮箱」的换算与校验。**这里是唯一口径，Flutter 端必须照抄同一套规则。**
//
// 背景：学生记得住手机号，但很多人没有邮箱也记不住邮箱。所以手机号当账号名用。
//
// 为什么是"合成邮箱"而不是 Supabase 原生的 phone 认证：启用 Phone provider 必须
// 先配短信服务商（Twilio 等），而发往国内 +86 的短信要么到不了、要么需要企业资质与
// 签名模板审批。本项目没有短信服务商。详见 supabase/migrations/0064_phone_login.sql。
//
// 于是：学生输入 `13800138000`，实际存成 `13800138000@phone.myquiz.cn`。
// 该域名自有、永不作收信用途，且邮箱确认本来就是关的（autoconfirm）。
//
// **一个账号只有一个标识符**：auth.users 的 email 字段只有一个，所以老用户
// （真实邮箱）无法"同时"再用手机号登录 —— 这是本方案的固有取舍，不是 bug。

/**
 * 合成邮箱的域名。
 * **改动它会作废所有已注册的手机号账号**（它们是用旧域名存进 auth.users.email 的）。
 */
export const PHONE_EMAIL_DOMAIN = "phone.myquiz.cn"

/** 中国大陆手机号：1 开头，第二位 3–9，共 11 位。 */
const CN_MOBILE = /^1[3-9]\d{9}$/

/**
 * 规范化成 11 位纯数字。合法返回号码，不合法返回 null。
 *
 * 容忍常见写法：`138 0013 8000`、`138-0013-8000`、`+8613800138000`、`8613800138000`。
 * 返回 null 而不是抛错，是为了让调用方能给出"手机号格式不对"这种面向用户的提示。
 */
export function normalizePhone(input) {
  if (typeof input !== "string") return null
  // 先去掉书写分隔符，再处理国家码
  let s = input.replace(/[\s\-()]/g, "")
  if (s.startsWith("+")) s = s.slice(1)
  // 只在"去掉 86 后正好是 11 位"时才当国家码剥掉，
  // 否则 8613800138000 这类和已带 86 的号码会被误伤
  if (s.startsWith("86") && s.length > 11) s = s.slice(2)
  return CN_MOBILE.test(s) ? s : null
}

/** 11 位手机号 → 合成邮箱。传入非规范写法会先规范化；不合法返回 null。 */
export function phoneToEmail(phone) {
  const p = normalizePhone(phone)
  return p ? `${p}@${PHONE_EMAIL_DOMAIN}` : null
}

/** 合成邮箱 → 11 位手机号；不是合成邮箱（或不合法）则返回 null。 */
export function emailToPhone(email) {
  if (typeof email !== "string") return null
  const suffix = `@${PHONE_EMAIL_DOMAIN}`
  if (!email.toLowerCase().endsWith(suffix)) return null
  const local = email.slice(0, -suffix.length)
  return CN_MOBILE.test(local) ? local : null
}

/**
 * 登录框的分流判据：**不含 `@` 就按手机号处理**。
 *
 * 刻意不写成 `normalizePhone(input) !== null`：那样的话用户把手机号少打一位，
 * 就会被当成邮箱去查，报出来的是"邮箱或密码不正确"—— 驴唇不对马嘴。
 * 这里只判断"用户想走哪条路"，格式对不对交给 normalizePhone 单独报错。
 */
export function looksLikePhone(input) {
  return typeof input === "string" && !input.includes("@")
}

/**
 * 把登录框/注册框里的输入统一换算成要交给 Supabase 的 email。
 * 返回 `{ email, phone }`：phone 非空表示这是个手机号账号（供落库到 profiles.phone）。
 * 输入既不像邮箱也不是合法手机号时返回 `{ email: null, phone: null }`。
 */
export function toAuthIdentifier(input) {
  const raw = typeof input === "string" ? input.trim() : ""
  if (!raw) return { email: null, phone: null }

  if (looksLikePhone(raw)) {
    const phone = normalizePhone(raw)
    return phone ? { email: phoneToEmail(phone), phone } : { email: null, phone: null }
  }
  return { email: raw.toLowerCase(), phone: null }
}

/** 展示用：`13800138000` → `138 0013 8000`。非手机号原样返回。 */
export function formatPhone(input) {
  const p = normalizePhone(input)
  if (!p) return input
  return `${p.slice(0, 3)} ${p.slice(3, 7)} ${p.slice(7)}`
}

/**
 * 邮箱的**展示值**：合成邮箱一律折叠成空串。
 *
 * `13800138000@phone.myquiz.cn` 是实现细节（见本文件顶部），**不是用户拥有的邮箱**。
 * 直接印出来，用户会以为自己有个怪邮箱，还可能往那儿发信、或者以为账号出了问题。
 * 手机号用户没有邮箱，展示层就该显示「未绑定」。
 */
export function displayEmail(email) {
  if (typeof email !== "string") return ""
  return emailToPhone(email) ? "" : email
}

/**
 * 账号的**单行**标识（紧凑列表用）：有手机号显示手机号，否则显示邮箱。
 *
 * 注意它只显示一个 —— 个人资料页要**分开展示**手机号与邮箱两行（用户可能有其一、
 * 也可能将来两者都有），别拿这个函数去渲染资料页。
 */
export function displayIdentifier({ phone, email } = {}) {
  if (phone) return formatPhone(phone)
  // 光有合成邮箱时（理论上不该出现：有合成邮箱就该有 profiles.phone），
  // 至少把它还原成手机号，别把假地址露出去
  const asPhone = emailToPhone(email)
  if (asPhone) return formatPhone(asPhone)
  return email || ""
}
