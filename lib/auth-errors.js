// Supabase Auth 英文报错 → 中文提示（登录/注册共用；未收录的原样透传）。
const MESSAGES = {
  "Invalid login credentials": "邮箱或密码不正确",
  "Email not confirmed": "邮箱尚未验证，请先到邮箱点击验证链接",
  "User already registered": "该邮箱已被注册",
  "Password should be at least 6 characters": "密码长度至少 6 位",
  "Signups not allowed for this instance": "当前不允许自助注册，请联系管理员",
}

export const translateAuthError = (message) => MESSAGES[message] ?? message
