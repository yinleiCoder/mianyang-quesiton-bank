# OSS 流量优化与 CDN 方案

> 2026-11-05 整理。**本文档只描述方案，不改代码** —— 用户选择先出方案，等备案有进展再动。
> 价格取自 2026 年公开资料，签约前必须以阿里云控制台的报价为准（见文末「价格出处」）。

## 1. 现状（实测，不是估计）

| 项目 | 现状 | 出处 |
|---|---|---|
| 媒体域名 | `mianyang-question-bank.oss-cn-chengdu.aliyuncs.com`（阿里云默认域名，成都） | `.env.local:17`、`.github/workflows/ci.yml:46` |
| CDN | **没有**。仓库里没有任何 CDN/图片代理依赖或配置 | 全仓搜索 |
| 图片压缩 | **已做**：`lib/oss-url.js` 给图片追加 `x-oss-process=image/resize,w_720/quality,Q_80/format,webp` | `lib/oss-url.js:43-66` |
| 缓存头 | **完全没设**：`/api/oss/sign` 的 POST policy 里没有 `Cache-Control`，对象元数据里也就没有 | `app/api/oss/sign/route.js:84-113` |
| Next 图片优化 | 没启用（全站没有 `next/image`，也没有 `images` 配置） | 全仓搜索 |
| 复习资料下载 | `/api/materials/download` 302 到签名地址 | `app/api/materials/download/route.js:63-77` |

一张题干插图原图 7.6 MB，缩到 `w_720 + webp` 后约 38 KB（`lib/oss-url.js` 文件头记录）。
**所以「图片太大」不是当前的主要问题，重复下载才是。**

## 2. 钱花在哪：先分清三种流量

1. **回访重复下载**：对象没有 `Cache-Control`，浏览器按启发式规则处理带查询串的 URL，
   往往每次进页面都重新拉一遍。同一张图一天被同一个人看十次 = 十次外网流出。
2. **资料下载**（PDF / zip / 音视频）：无法压缩，只能靠缓存与 CDN。
3. **CDN 回源**：只有加了 CDN 才产生。

## 3. 不依赖备案就能做的三件事（按性价比排序）

### 3.1 给新对象写长缓存头（改动最小，收益最大）

`app/api/oss/sign/route.js` 的 policy 增加一条条件，form fields 增加一个字段：

```js
conditions: [
  // …现有的 content-length-range / bucket / $key / $Content-Type…
  ["eq", "$Cache-Control", "public, max-age=31536000, immutable"],
],
fields: {
  // …
  "Cache-Control": "public, max-age=31536000, immutable",
},
```

- 为什么可行：对象 key 是服务端生成的 `qbank/YYYY/MM/<uuid>.<ext>`（`sign/route.js:82`），
  **UUID 天然不可覆盖**，换成新文件就是一个新 key。`immutable` 的前提成立。
- 为什么必须写进 policy：OSS PostObject 要求除少数固定字段外的所有表单字段都出现在
  policy 里，漏了会直接 `Invalid according to Policy`。
- 影响面：网页端与 Flutter 端共用这一个签字接口，改一处两端生效。

### 3.2 回填存量对象（一次性）

用 CopyObject + `x-oss-metadata-directive: REPLACE` 把已有对象补上同样的 `Cache-Control`。
签名与请求写法直接照抄 `scripts/client-apk-alias.mjs:55-70`（同一套 OSS V1 签名）。
注意 `lib/oss-sign.mjs` 里记过的坑：**URL 里的子资源要 encode，签名串里必须是原文**，
两处都编码会 `SignatureDoesNotMatch`。

建议做成 `scripts/oss-backfill-cache-control.mjs`，带 `--dry-run`，先跑一个前缀验证再铺开。

### 3.3 别把 `raw: true` 优化掉

`mediaUrl(key, { raw: true })` 是给导出 PDF 用的（react-pdf 不认 webp）。
把默认档和 raw 档合并会直接让 PDF 导出挂掉 —— 这是踩过的雷，见 `docs/paper-pdf-export-design.md`。

### 预估收益

缓存头到位后，同一用户的重复浏览从「每次都回源」变成「命中本地缓存」，
回访流量的下降幅度取决于重复率。资料（PDF/zip）的重复下载也会被浏览器缓存，
但**下载按钮的用户预期是拿到最新文件**，评估时要单独看这一类。

## 4. 备案：为什么它是 CDN 的前置条件

**结论：`myquiz.cn` 没有有效 ICP 备案。** 记录见 `AGENTS.md`（2026-10-27：绑定
`download.myquiz.cn` 到大陆 bucket 因备案问题失败）。

现在能跑，是因为两条链路都落在「不需要备案」的地方：

- 网页在 **Vercel 香港**（境外服务器，不归大陆管局管）；
- 媒体走 **OSS 默认域名** `*.aliyuncs.com`（阿里云自己备过案，租户用默认域名免备案）。

一旦要做以下任何一件事，就必须先备案：

- 给 OSS 绑自定义域名（如 `media.myquiz.cn`）；
- 开阿里云 CDN 的**中国大陆**加速节点。

### 备案要点（据 2026 年公开流程整理，以接入商指引为准）

1. **主体**：单位（营业执照 / 事业单位法人证书）。个人备案不能做教育类站点。
2. **域名**：`.cn` 必须在境内注册商，完成实名认证，且持有者与备案主体一致。
3. **接入商**：需要大陆境内的云资源（阿里云 ECS/OSS 等）与「备案服务号」。
4. **前置审批**：教育属于需要前置审批的行业（《互联网信息服务管理办法》第五条），
   多数省份要求提供省级教育主管部门的证明材料 —— **这是最容易卡住的一步**。
5. **时限**：接入商初审 1–3 个工作日 + 管局审核约 10–20 个工作日。
6. **后续**：备案号要展示在网站底部；**CDN 加速域名还要单独做「新增域名」备案**，
   不能复用主域名的备案号。

## 5. CDN 选型

### 5.1 阿里云 CDN（备案后才能用，推荐）

- 大陆节点，回源走阿里云内网链路（OSS 同地域），延迟最低。
- 支持 URL 鉴权、Referer 防盗链、缓存规则按后缀配置。

### 5.2 Cloudflare 代理（免备案，但不建议）

技术上可行：`media.myquiz.cn` 走 Cloudflare 代理，用 Origin Rule 把 Host 改回
`mianyang-question-bank.oss-cn-chengdu.aliyuncs.com`（OSS 默认域名要求 Host 匹配 bucket，
不改 Host 会 `NoSuchBucket`）。但：

- **大陆用户体验会变差**：Cloudflare 免费/Pro 的大陆入口在香港、新加坡、美西，
  对成都 OSS 的直连（同城、个位数毫秒）反而是倒退。
- 仓库里已有明确结论：`supabase-proxy/README.md:74-82` 写着「OSS 那行别碰」，
  免费版 Worker 10 万次/天且全局共享配额。
- Cloudflare 服务条款对「大量非 HTML 内容的分发」有限制。

**结论：除非以后用户主体在境外，否则不走 Cloudflare。**

### 5.3 成本对比（中国内地，按量付费）

| 项目 | 单价 | 备注 |
|---|---|---|
| OSS 外网流出（忙时 08:00–24:00） | 约 **0.50 元/GB** | 第三方整理，需核对控制台 |
| OSS 外网流出（闲时 00:00–08:00） | 约 **0.25 元/GB** | 同上 |
| OSS → CDN 回源流量 | 约 **0.15 元/GB** | 同上 |
| CDN 中国内地下行（0–10TB） | 约 **0.24 元/GB** | 阶梯计价，量大更低 |

按上述单价，若缓存命中率为 `h`，走 CDN 的每 GB 成本约为
`0.24 + (1 − h) × 0.15`；即使 `h = 0` 也低于 OSS 忙时单价。
**但真正省钱的是 3.1 的缓存头**（命中浏览器缓存 = 0 元），CDN 是它的放大器。

## 6. 切 CDN 时要改的代码（提前知道，不用现在改）

1. **媒体地址**：`NEXT_PUBLIC_OSS_PUBLIC_HOST` 改成 CDN 域名即可 —— 全站只有
   `lib/oss-url.js:19,61` 在读它。Flutter 端对应 `config/*.json` 的 `OSS_PUBLIC_HOST`。
2. **签名下载不要跟着换**：`/api/materials/download` 必须继续签**桶自己的域名**
   （`app/api/materials/download/route.js:63-64` 已经写明原因：Host 参与签名校验）。
   签名地址经 302 跳到桶域名 = 那次下载绕过 CDN，功能仍然正确。
3. **CORS**：`scripts/oss-cors.mjs` 维护的是桶的 CORS。若 CDN 域名要直连（例如
   `apk-download` 那种 fetch → Blob），CDN 侧也要放行同样的源。
4. **`x-oss-process` 与 CDN**：CDN 默认会把带查询串的 URL 当作不同缓存键，
   图片处理参数会各自缓存一份，属正常行为。

## 7. 验收口径

- `curl -I` 任意一个媒体对象，应能看到 `Cache-Control: public, max-age=31536000, immutable`；
- 浏览器 DevTools 的 Network 面板第二次进同一道题：图片应为 `(disk cache)` / `304`；
- 阿里云账单里「OSS 外网流出流量」按周对比改前 / 改后；
- 切 CDN 后用 `curl -I` 确认响应头带 `Via` / `X-Cache`，且签名下载仍能成功。

## 价格出处

- [阿里云 OSS 流量费用](https://help.aliyun.com/zh/oss/traffic-fees)
- [2026 年阿里云 OSS 收费标准整理（开发者社区）](https://developer.aliyun.com/article/1704273)
- [阿里云 CDN 基础服务计费](https://www.alibabacloud.com/help/zh/cdn/product-overview/billing-rules-of-basic-services)
- [2026 阿里云 CDN 收费标准整理（开发者社区）](https://developer.aliyun.com/article/1708278)
