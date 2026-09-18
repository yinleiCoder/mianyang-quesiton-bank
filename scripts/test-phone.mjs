// 跑法：node scripts/test-phone.mjs
//
// 只测 lib/phone.js 的换算口径。这里的边界值不是凑数的 —— 换算写错的表现是
// 「同一个手机号在 web 和 App 落到不同账号」，线上排查起来极其费劲，所以钉死在测试里。
import assert from "node:assert/strict"
import {
  normalizePhone,
  phoneToEmail,
  emailToPhone,
  looksLikePhone,
  toAuthIdentifier,
  formatPhone,
  displayIdentifier,
  displayEmail,
  PHONE_EMAIL_DOMAIN,
} from "../lib/phone.js"

let n = 0
const t = (name, fn) => {
  try {
    fn()
    n++
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`)
    process.exitCode = 1
  }
}

// ---- normalizePhone：合法写法都要能认出来 ----
t("裸 11 位", () => assert.equal(normalizePhone("13800138000"), "13800138000"))
t("带空格", () => assert.equal(normalizePhone("138 0013 8000"), "13800138000"))
t("带连字符", () => assert.equal(normalizePhone("138-0013-8000"), "13800138000"))
t("带括号", () => assert.equal(normalizePhone("(138)0013-8000"), "13800138000"))
t("+86 前缀", () => assert.equal(normalizePhone("+8613800138000"), "13800138000"))
t("86 前缀（无加号）", () => assert.equal(normalizePhone("8613800138000"), "13800138000"))
t("+86 带空格", () => assert.equal(normalizePhone("+86 138 0013 8000"), "13800138000"))

// ---- normalizePhone：不合法的必须返回 null，不能"尽力而为"猜 ----
t("位数不足", () => assert.equal(normalizePhone("1380013800"), null))
t("位数过多", () => assert.equal(normalizePhone("138001380001"), null))
t("第二位是 2（非法号段）", () => assert.equal(normalizePhone("12800138000"), null))
t("开头不是 1", () => assert.equal(normalizePhone("23800138000"), null))
t("含字母", () => assert.equal(normalizePhone("1380013800a"), null))
t("空串", () => assert.equal(normalizePhone(""), null))
t("非字符串", () => assert.equal(normalizePhone(null), null))
// 这条是关键：861380013800 去掉 86 后只剩 10 位，不能被当成合法号码
t("86 开头但总长不够", () => assert.equal(normalizePhone("861380013800"), null))

// ---- 往返一致：这是 web 与 App 落到同一账号的前提 ----
t("phone → email → phone 往返", () => {
  for (const raw of ["13800138000", "+8613800138000", "138 0013 8000"]) {
    const p = normalizePhone(raw)
    assert.equal(emailToPhone(phoneToEmail(p)), p)
    assert.equal(phoneToEmail(raw), `${p}@${PHONE_EMAIL_DOMAIN}`)
  }
})

// ---- emailToPhone：只认自己的域名 ----
t("真实邮箱不是手机号账号", () => assert.equal(emailToPhone("teacher@qq.com"), null))
t("同前缀的别的域名不认", () => assert.equal(emailToPhone("13800138000@phone.evil.com"), null))
t("域名大小写不敏感", () => assert.equal(emailToPhone("13800138000@PHONE.MYQUIZ.CN"), "13800138000"))
t("合成域名但本地部分不合法", () => assert.equal(emailToPhone(`abc@${PHONE_EMAIL_DOMAIN}`), null))

// ---- looksLikePhone：分流只看"有没有 @"，不判格式 ----
t("纯数字算手机号路子", () => assert.equal(looksLikePhone("13800138000"), true))
t("少一位也仍算手机号路子（要报格式错，不能当邮箱查）", () =>
  assert.equal(looksLikePhone("1380013800"), true))
t("含 @ 算邮箱路子", () => assert.equal(looksLikePhone("a@b.com"), false))

// ---- toAuthIdentifier：表单真正调用的那个 ----
t("手机号输入 → 合成邮箱 + phone", () => {
  assert.deepEqual(toAuthIdentifier("138 0013 8000"), {
    email: `13800138000@${PHONE_EMAIL_DOMAIN}`,
    phone: "13800138000",
  })
})
t("邮箱输入 → 原样（小写）+ 无 phone", () => {
  assert.deepEqual(toAuthIdentifier("Teacher@QQ.com"), { email: "teacher@qq.com", phone: null })
})
t("手机号格式错 → 两个都 null（调用方据此报错）", () => {
  assert.deepEqual(toAuthIdentifier("1380013"), { email: null, phone: null })
})
t("空输入 → 两个都 null", () => {
  assert.deepEqual(toAuthIdentifier("   "), { email: null, phone: null })
})

// ---- 展示 ----
t("formatPhone 分组", () => assert.equal(formatPhone("13800138000"), "138 0013 8000"))
t("formatPhone 非手机号原样返回", () => assert.equal(formatPhone("abc"), "abc"))
t("displayIdentifier 优先手机号", () =>
  assert.equal(displayIdentifier({ phone: "13800138000", email: "x@y.com" }), "138 0013 8000"))
t("displayIdentifier 退回邮箱", () =>
  assert.equal(displayIdentifier({ phone: null, email: "teacher@qq.com" }), "teacher@qq.com"))
t("displayIdentifier 合成邮箱也显示成手机号", () =>
  assert.equal(
    displayIdentifier({ phone: null, email: `13800138000@${PHONE_EMAIL_DOMAIN}` }),
    "138 0013 8000"
  ))
t("displayIdentifier 空对象不炸", () => assert.equal(displayIdentifier({}), ""))
t("displayIdentifier 无参数不炸", () => assert.equal(displayIdentifier(), ""))

// ---- displayEmail：合成邮箱绝不能露给用户 ----
// 这是「手机号、邮箱区分显示」的地基：资料页的邮箱那一行对手机号用户必须是空的
// （渲染成「未绑定」），而不是 13800138000@phone.myquiz.cn
t("合成邮箱折叠成空串", () =>
  assert.equal(displayEmail(`13800138000@${PHONE_EMAIL_DOMAIN}`), ""))
t("真实邮箱原样返回", () => assert.equal(displayEmail("teacher@qq.com"), "teacher@qq.com"))
t("同前缀的别的域名不算合成邮箱", () =>
  assert.equal(displayEmail("13800138000@phone.evil.com"), "13800138000@phone.evil.com"))
t("null / undefined 折叠成空串", () => {
  assert.equal(displayEmail(null), "")
  assert.equal(displayEmail(undefined), "")
})

if (process.exitCode) {
  console.error(`\n失败。通过 ${n} 条。`)
} else {
  console.log(`✓ ${n} 条全部通过`)
}
