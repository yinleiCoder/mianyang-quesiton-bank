// 客户端发布资产的**唯一清单**：下载页、APK 下载按钮与运维脚本共用这一份。
//（用 .mjs：package.json 没有 "type": "module"，普通 .js 里的 export 没法被
// scripts/*.mjs 直接 import。与 lib/oss-sign.mjs 同一个理由。）
//
// 资产名与客户端仓库 `mianyang_quiz/tool/upload_to_oss.mjs` 推上去的名字**逐字一致**
//（那边特意不带版本号，同一个 OSS key 永远指向最新版）。改一处必须改另一处，
// 否则页面点下去是 404。
export const APK_ASSET = "mianyang_quiz-android.apk"
export const WIN_SETUP_ASSET = "mianyang_quiz-windows-x64-setup.exe"
export const WIN_ZIP_ASSET = "mianyang_quiz-windows-x64.zip"

/// 浏览器直连 OSS 的三个 APK（armv7 / x86_64 给老设备与模拟器）。
/// 这同时是 `/download/apk` 落地页 `?name=` 的**白名单**：不认别的名字，
/// 免得那条 URL 变成"随便指定 OSS 对象"的入口。
export const APK_ALIAS_ASSETS = [
  APK_ASSET,
  "mianyang_quiz-android-armv7.apk",
  "mianyang_quiz-android-x86_64.apk",
]

/// APK 在 OSS 里另存的无害副本 key（octet-stream、不带 Content-Disposition）。
/// 口径与 `mianyang_quiz/tool/upload_to_oss.mjs` 的 `ALIAS_PREFIX` 一致：
/// `<client 前缀>/dist/<资产名>.bin`。为什么必须是这样、以及浏览器怎么把它换成 .apk，
/// 见 components/download/apk-download.jsx。
export function clientApkAliasKey(name) {
  return `client/dist/${name}.bin`
}
