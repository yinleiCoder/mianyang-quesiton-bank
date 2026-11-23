// 客户端发布资产的**唯一清单**：下载页、APK 下载按钮与运维脚本共用这一份。
//（用 .mjs：package.json 没有 "type": "module"，普通 .js 里的 export 没法被
// scripts/*.mjs 直接 import。与 lib/oss-sign.mjs 同一个理由。）
//
// 资产名与客户端仓库 `mianyang_quiz/tool/upload_to_oss.mjs` 推上去的名字**逐字一致**
//（那边特意不带版本号，同一个 OSS key 永远指向最新版）。改一处必须改另一处，
// 否则页面点下去是 404。
export const WIN_SETUP_ASSET = "mianyang_quiz-windows-x64-setup.exe"
export const WIN_ZIP_ASSET = "mianyang_quiz-windows-x64.zip"

/// **默认/推荐的 Android 包是 arm64-v8a**（2026-11-02 定案，2026-11-23 起
/// 下载页把三份并列列出，它仍置顶高亮为「推荐」）。
///
/// 为什么是它而不是 armv7：armv7 覆盖面更广（32 位与 64 位真机通吃），
/// 但**用户反馈里没有"装不上"这一类**——闪退数据又全是 Windows 的，与 ABI 无关。
/// 在没有证据说 32 位用户成规模之前，推荐**性能更好**的那份；32 位与模拟器
/// 作为并列选项列在同一张卡片里，用户看得到、选得中。
///
/// ⚠ **代价要说清楚**：32 位手机点推荐按钮会装不上（一句「应用未安装」，
/// 且不告诉任何人该换哪个文件）。所以另外两份必须与推荐项一起列出、写清"给谁用"，
/// 不能藏进脚注。
///
/// 另一半原因是**不会换来**：装与更新必须落在同一个 ABI 上。
/// 客户端的更新检查按**自己实际在跑的 ABI** 选包（见
/// `mianyang_quiz/lib/utils/android_abi.dart`），所以不管网页端默认发哪份，
/// 更新都不会跨 ABI。
export const APK_ASSET = "mianyang_quiz-android.apk"

/// 另外两个 ABI 的包：32 位老设备与模拟器（下载页与推荐项并列列出）。
export const APK_ARMV7_ASSET = "mianyang_quiz-android-armv7.apk"
export const APK_X86_64_ASSET = "mianyang_quiz-android-x86_64.apk"

/// 三个 ABI 的**展示信息**：下载页与自动下载落地页共用这一份。
///
/// 顺序就是页面上的顺序，第一项是**推荐项**（arm64-v8a，见上面 APK_ASSET 的说明）。
/// 文案只回答一个问题——"我的设备能不能装"——不写"性能更好"这类用户判断不了的比较：
///   · arm64-v8a  64 位 ARMv8，2019 年以后绝大多数手机/平板；
///   · armeabi-v7a  32 位 ARM，老设备；64 位版提示「应用未安装」时换它；
///   · x86_64  64 位 x86，只给模拟器。
/// 参考 Android NDK 的 ABI 文档与 Flutter 的 `--split-per-abi` 说明。
export const APK_VARIANTS = [
  {
    name: APK_ASSET,
    abi: "arm64-v8a",
    label: "64 位",
    title: "64 位 · arm64-v8a",
    desc: "近几年（2019 年后）绝大多数手机和平板；不确定选哪个就用这份。",
    recommended: true,
  },
  {
    name: APK_ARMV7_ASSET,
    abi: "armeabi-v7a",
    label: "32 位",
    title: "32 位 · armeabi-v7a",
    desc: "老手机；64 位版提示「应用未安装」时换这份。",
    recommended: false,
  },
  {
    name: APK_X86_64_ASSET,
    abi: "x86_64",
    label: "模拟器",
    title: "模拟器 · x86_64",
    desc: "Android Studio 或雷电、夜神等模拟器；真机用不上。",
    recommended: false,
  },
]

/// 浏览器直连 OSS 的三个 APK。
/// 这同时是 `/download/apk` 落地页 `?name=` 的**白名单**：不认别的名字，
/// 免得那条 URL 变成"随便指定 OSS 对象"的入口。
///
/// **三个都得在**：清单里每个 APK 的 url 都按资产名指向本页
/// （`?name=<资产名>&v=<tag>`），线上那版清单对三个名字都发过链接，
/// 漏一个，收藏的旧链接就会变 404。所以从 APK_VARIANTS 派生，别再手抄一份。
export const APK_ALIAS_ASSETS = APK_VARIANTS.map((v) => v.name)

/// 按资产名取展示信息；白名单之外的名字回落到推荐项（与落地页的默认口径一致）。
export function apkVariant(name) {
  return APK_VARIANTS.find((v) => v.name === name) ?? APK_VARIANTS[0]
}

/// APK 在 OSS 里另存的无害副本 key（octet-stream、不带 Content-Disposition）。
/// 口径与 `mianyang_quiz/tool/upload_to_oss.mjs` 的 `ALIAS_PREFIX` 一致：
/// `<client 前缀>/dist/<资产名>.bin`。为什么必须是这样、以及浏览器怎么把它换成 .apk，
/// 见 components/download/apk-download.jsx。
export function clientApkAliasKey(name) {
  return `client/dist/${name}.bin`
}
