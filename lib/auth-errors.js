// Supabase Auth 英文报错 → 中文提示（登录/注册共用；未收录的原样透传）。
//
// 文案里写「手机号/邮箱」而不是单说邮箱：账号现在两种都有，学生绝大多数是手机号，
// 提示里只出现"邮箱"会让人以为走错了入口。
const MESSAGES = {
  "Invalid login credentials": "手机号/邮箱或密码不正确",
  "Email not confirmed": "账号尚未验证，请先完成验证",
  "User already registered": "该手机号/邮箱已被注册",
  "Password should be at least 6 characters": "密码长度至少 6 位",
  "Signups not allowed for this instance": "当前不允许自助注册，请联系管理员",
  // 账号已存在时 Supabase 可能返回这句（防枚举），措辞与 "User already registered" 统一
  "A user with this email address has already been registered": "该手机号/邮箱已被注册",
}

export const translateAuthError = (message) => MESSAGES[message] ?? message
