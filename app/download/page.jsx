// 客户端下载页（公开页，不需要登录）。
//
// 线路分工（2026-10-29 起，全部走自家阿里云 OSS）：
//   · 版本清单 latest.json 与 Windows 安装包/zip 用 OSS 直链；
//   · **APK 由浏览器直连 OSS 的 `.bin` 副本、在客户端换成 .apk 存盘**：
//     阿里云默认域名禁止分发 .apk（key 后缀 / Content-Type / Content-Disposition
//     文件名三条都挡，签名地址也一样），而绑定自定义域名要大陆备案。更关键的是
//     **服务端补文件名也走不通**：Vercel 香港函数连不上成都 OSS（连接稳定地在
//     10 秒后超时，构建环境却能连），所以原来的 /api/client/download 路由对谁都是 502。
//     浏览器到 OSS 又快又稳，取名字这一步放在浏览器里做（见 apk-download.jsx）。
//
// 页面内容全部在客户端组件里：清单也在浏览器取（原因同上，服务端读清单会失败，
// 版本号与 SHA 列表会静默消失）。本文件只留 metadata 与壳。
import { DownloadPageClient } from "@/components/download/download-page-client"

export const metadata = {
  title: "下载客户端",
  description:
    "职教高考联盟的 Android 与 Windows 客户端：与网页端共用同一套题库和账号，随手刷题、背题、看学情。",
}

export default function DownloadPage() {
  return <DownloadPageClient />
}
