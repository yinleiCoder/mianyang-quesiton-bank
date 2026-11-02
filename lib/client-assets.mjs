// 客户端发布资产的**唯一清单**：下载页、APK 下载按钮与运维脚本共用这一份。
//（用 .mjs：package.json 没有 "type": "module"，普通 .js 里的 export 没法被
// scripts/*.mjs 直接 import。与 lib/oss-sign.mjs 同一个理由。）
//
// 资产名与客户端仓库 `mianyang_quiz/tool/upload_to_oss.mjs` 推上去的名字**逐字一致**
//（那边特意不带版本号，同一个 OSS key 永远指向最新版）。改一处必须改另一处，
// 否则页面点下去是 404。
export const WIN_SETUP_ASSET = "mianyang_quiz-windows-x64-setup.exe"
export const WIN_ZIP_ASSET = "mianyang_quiz-windows-x64.zip"

/// **默认下发的 Android 包是 arm64-v8a**（2026-11-02 定案）。
///
/// 为什么是它而不是 armv7：armv7 覆盖面更广（32 位与 64 位真机通吃），
/// 但**用户反馈里没有"装不上"这一类**——闪退数据又全是 Windows 的，与 ABI 无关。
/// 在没有证据说 32 位用户成规模之前，默认给**性能更好**的那份；
/// 32 位设备由页面上的「32 位版」链接兜底。
///
/// ⚠ **代价要说清楚**：32 位手机点主按钮会装不上（一句「应用未安装」，
/// 且不告诉任何人该换哪个文件）。所以那个备用链接必须显眼，不能藏。
///
/// 另一半原因是**不会换来**：装与更新必须落在同一个 ABI 上。
/// 客户端的更新检查按**自己实际在跑的 ABI** 选包（见
/// `mianyang_quiz/lib/utils/android_abi.dart`），所以不管网页端默认发哪份，
/// 更新都不会跨 ABI。
export const APK_ASSET = "mianyang_quiz-android.apk"

/// 另外两个 ABI 的包：32 位老设备的兜底，与模拟器。
export const APK_ARMV7_ASSET = "mianyang_quiz-android-armv7.apk"
export const APK_X86_64_ASSET = "mianyang_quiz-android-x86_64.apk"

/// 浏览器直连 OSS 的三个 APK。
/// 这同时是 `/download/apk` 落地页 `?name=` 的**白名单**：不认别的名字，
/// 免得那条 URL 变成"随便指定 OSS 对象"的入口。
///
/// **三个都得在**：清单里每个 APK 的 url 都按资产名指向本页
/// （`?name=<资产名>&v=<tag>`），线上那版清单对三个名字都发过链接，
/// 漏一个，收藏的旧链接就会变 404。
export const APK_ALIAS_ASSETS = [
  APK_ASSET,
  APK_ARMV7_ASSET,
  APK_X86_64_ASSET,
]

/// APK 在 OSS 里另存的无害副本 key（octet-stream、不带 Content-Disposition）。
/// 口径与 `mianyang_quiz/tool/upload_to_oss.mjs` 的 `ALIAS_PREFIX` 一致：
/// `<client 前缀>/dist/<资产名>.bin`。为什么必须是这样、以及浏览器怎么把它换成 .apk，
/// 见 components/download/apk-download.jsx。
export function clientApkAliasKey(name) {
  return `client/dist/${name}.bin`
}
