<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 查重（2026-09-29 接入界面）

引擎早就写好了（0035 的 `import_find_similar`，那个迁移自己标了「v1 未接 UI」），
底层一应俱全：`pg_trgm`、`question_versions.search_text` + GIN 索引、
`question_search_text()` 在建草稿/编辑/导入时都维护、`import_job_items.content_hash`
（`md5(题干 || '|' || 答案)`）写入时算好。缺的只是把结果给到人看。

### ⚠ 阈值 0.55 **不能**直接当"疑似重复"

2026-09-29 拿线上 **380 道已发布题**跑了全部 **72,010 个配对**：`>0.55` 的只有 9 对，
**其中真重复只有 2 对**（都是同题换了个空位写法：`______` vs `( )`）。

其余 7 对是**同一知识点、不同侧面的辨析题**，包括刻意配成一对的：

```
0.563  在单元格中输入数字时，Excel 自动将它左对齐。
       在单元格中输入文本时，Excel 自动将它右对齐。      ← 恰好互为反面
0.789  …对 C3 和 D4 的行地址绝对引用，列地址相对引用
       …对 C3 和 D4 的列地址绝对引用，行地址相对引用      ← 恰好互为反面
```

**在 0.55 上直接报「疑似重复」，会把这类题判死，还会把审核人训练成"这提示一律忽略"**
——那比不做查重更糟。所以两处界面都**分档**，低档明确写「供参考」而不是「疑似重复」：

| 档 | 阈值 | 界面措辞 |
|---|---|---|
| 高度相似 | ≥0.85 | 多半是同一道题换了个写法，请对照后再决定 |
| 较相似 | ≥0.70 | 同一知识点的辨析题也会落在这一档，**不一定是重复** |
| 供参考 | 0.55~0.70 | 这个区间大多是辨析题，是正常的 |

### 三个入口，口径必须一致

| 场景 | 实现 | 落点 |
|---|---|---|
| AI 解析导入 | `import_find_similar(p_job_id)`，**一次问整个任务**（已按相似度降序，同一 item 首条即最优） | `components/import/import-preview.jsx` |
| 手动录入 | `find_similar_questions(p_content)`（0081 新增，不绑 job、守卫是 `is_teacher()`、题干短于 8 字直接返回空） | `components/questions/question-editor.jsx`，防抖 600ms |
| 卷内重复 | 同页：`import-pipeline.js` 的 `dup_in_job`（**丢**掉后出现的）；跨页：预览页**客户端**算（**只标不丢**） | 各自 |

改任何一个的判据之前，先看另一个——"AI 导入提示、手动录入不提示"会让人不知道该信哪个。

### 两个刻意的行为

- **查重失败不挡流程**：导入预览里 RPC 报错只弹一句提示；手动录入里**静默**。
  它是辅助信息，不参与"能不能存"的判断。
- **跨页重复不落库**：预览页客户端算的，换视图看不到。**没有**改
  `import_save_page`（线上 5300 字的解析主链路），为一条提示改它风险不成比例。
  代价是它只是审核时的提示——而那正是它要起作用的地方。

## 试卷导出 PDF（2026-10-08 完成）

网页端能直接**下载**一份试卷 PDF（自己排版、内嵌字体），与原来的「浏览器打印 → 另存为」
两条出口并存。方案与踩过的四颗雷写在 `docs/paper-pdf-export-design.md`，**改这块之前先读那份**。

三条最容易复发的：

- **卷面排版有两份实现**：`components/papers/paper-sheet.jsx`（网页/打印）与
  `components/papers/paper-pdf-document.jsx`（react-pdf）。改一个必须改另一个，否则
  下载到的 PDF 会慢慢和网页上看到的不是同一张纸。
- **字体里 U+002D 的字宽是 0**（`scripts/build-cjk-subset.mjs` 故意做的，为了让断行处
  引擎自动插的连字符隐形）。所以正文里的连字符必须走 `printableText()` 换成 U+2011，
  直接写 `-` 会印不出来。
- **`render` 回调 + `lineHeight` = 文字消失**（页脚踩过）。页脚只能挂在 Page 直下，
  Page 上不能写 lineHeight（行距挂在正文包装层）。
- **取图要用 `mediaUrl(key, { raw: true })`**，不能直接用默认档：默认档会转 webp，
  而 react-pdf 不认 webp，整份导出会挂（不是那一张图降级）。`lib/pdf-prep.js` 另外按
  魔术字节嗅探兜底，认不出来的图退化成一行说明文字。

自检：`npm run test:pdf`（在 node 里渲染真 PDF 再用 pdfjs 抽回文字与文字包围盒核对，
含「长复合题不重叠」回归）；浏览器端用 `/dev-pdf-export` 与 `/dev-approval-flow`
两个夹具页（都不需要登录）。

### 2026-10-27 修的两颗雷（打印重叠 / 行距）

- **`wrap={false}` 的题项高过一整页 = 溢出重叠**：react-pdf 只打一句 `console.warn`，
  PDF 照样生成，纸上后一题会画在前一题上面（真实的材料分析题 + 图 + 5~6 个小问就会超）。
  `lib/pdf-prep.js` 的 `canKeepTogether()` 先估高度，超过 700pt 就不给 `wrap={false}`；
  回归在 `npm run test:pdf` 的「长复合题」一组（同时抓警告与文字包围盒）。
- **无单位 `lineHeight` 乘的是"处理这条样式时能看到的 fontSize"**：只写在 View 上、
  没写 fontSize 时乘的是默认 18 而不是继承的 10.5 —— 行距 28.8pt，一本卷子印出 28 页。
  `S.body` 必须同时写 `fontSize: 10.5` 与 `lineHeight: 1.6`。
- **网页打印的 A4 版式**在 `app/globals.css` 的 `@media print`：`@page size A4 portrait`、
  上下 18mm / 左右 16mm、页码走 `@bottom-center` 的 `counter(page)/counter(pages)`
  （Chrome 131+ 支持，其余浏览器整块忽略），并强制 `body { display: block }`
  —— 屏幕上的 body 是 flex，跨页的 flex 子项曾是重叠来源。

## 教学动画空间（做过，2026-10-09 掐掉了）

前后两版都撤了，**别再建**：

1. 先做的是"教师在站内用 Remotion 写动画、浏览器渲染、走两级审批"（沙箱 + AI 写代码 +
   esbuild 构建 + 三个 npm 包 + 一张源码表），做完 M0-M4 之后用户判断"制作放本站加大了复杂度"。
2. 改成"上传视频 + 播放"之后，用户又决定**整个功能不要了**。

代码、路由、侧栏入口、`PURPOSES.animation`、设计文档都已删除。
**数据库里 `teaching_animations` / 它引用的那几张表和 OSS 上的视频还在**（删表不可逆，
且删完 OSS 上的文件会变成孤儿），要清的话单独说。

留两条将来若重做会立刻用到的结论（原设计文档已删，记在这里）：

- **AI 生成的代码绝不能同源执行** —— `@supabase/ssr` 的会话 cookie **不是 httpOnly**
  （浏览器端直接读写 `document.cookie`），任何同源脚本都能读走登录态。真要执行外部代码，
  唯一可行的载体是 `sandbox="allow-scripts"` 的不透明源 iframe（不给 allow-same-origin）。
- 那种 iframe 里 **CSP 的 `'self'` 不匹配**（规范明写），所以只能加载内联脚本；
  `type="module"` 与 `fetch()` 全被 CORS 拦。而且里面 **`window.localStorage` 是抛异常、
  不是 `undefined`**（`typeof` 也救不了）。

## 复习资料：zip 上传 + 下载按钮（2026-10-12）

- **zip 只对资料区开放**（`lib/media-spec.js` 的 `MATERIAL_ONLY_TYPES`），题库附件那份清单里没有它。
  三个 mime 必须都收——`application/zip`（macOS/Linux）、**`application/x-zip-compressed`
  （Windows 上 Chrome/Edge 报的是这个）**、`application/x-zip`。少收一个，就成了"同一份压缩包
  换个系统传不上来"，而报错只说"不支持该类型"，很难自查到是系统差异。
- **下载走 `/api/materials/download`（302 到签名地址），不是直开 OSS 公网地址**：只有带签名的
  请求 `response-content-disposition` 才生效，而它决定存下来的文件名是《标题.pdf》还是一串 uuid；
  顺带在服务端把 download_count +1。**别改成"服务端转发一遍"**——单份上限 2GB，
  那等于把全市的下载流量压在 Next 函数上（还白多一跳：OSS 在成都、函数在香港）。
- ⚠ **OSS 子资源的值有两副面孔**：URL 里要 `encodeURIComponent` 之后的，**签名串里必须是原文**
  （两处都编码 = SignatureDoesNotMatch，2026-10-12 实测才定下来）。见 `lib/oss-sign.mjs` 的 `ossSignedUrl`。
  文件名口径（洗非法字符 + 用 objectKey 的扩展名补后缀）在 `lib/materials.js` 的 `materialFileName`，
  与 Flutter 端 `material_brief.dart` 的 `suggestedFileName` 逐条一致，改一处要改另一处。

## 客户端下载：双端都由浏览器直连 OSS（2026-10-29 起）

GitHub release 资产国内直连不可用；自家成都 OSS 快。**gh-proxy 已停用**
（2026-10-27 用户拍板：太慢），网页端 `NEXT_PUBLIC_GH_PROXY` 与客户端 `Env.ghProxy`
都已删除。APK 与 Windows 唯一的区别是：阿里云不让 `.apk` 这种"长相"从默认域名出去，
所以 APK 在桶里存 `.bin` 副本，由**浏览器**取回后改名存盘。

### 阿里云发不了 .apk（三条判据，2026-10-27 逐条实测）

阿里云默认域名（`*.aliyuncs.com`）回 400 `ApkDownloadForbidden`，下面三条命中任意一条
就挡，**带签名的地址也一样挡**：

1. 对象 key 以 `.apk` 结尾；
2. 响应的 `Content-Type` 是 `application/vnd.android.package-archive`；
3. `Content-Disposition` 里的文件名以 `.apk` 结尾。

绑定自定义域名要求大陆 ICP 备案（`myquiz.cn` 没有有效备案），短期走不通。
浏览器这边也别指望擦边写法：`filename="…apk."` 在 Chrome 里会存成 `…apk_`（实测）。

### 服务端补文件名也走不通（2026-10-29 实测）

`/api/client/download` 那条转发路由上线后**对任何人都是 502**：Vercel 香港函数（hkg1）
连不上成都 OSS —— 连接稳定地在 ~10 秒后超时（undici 的 connect timeout），而同一个
部署的**构建环境**却能取到清单。更隐蔽的是 `/download` 的服务端 ISR 重新生成也会失败，
版本号与 SHA 列表会静默消失。`preferredRegion` 在 Next 16 已废弃（Vercel 只认
`auto|global|home`），换不了区域。**别再写服务端转发 OSS 的下载路由。**

### 解法：`.bin` 副本 + 浏览器改名

- 发布脚本把每个 APK **另存一份** `client/dist/<资产名>.bin`（`application/octet-stream`、
  不带 `Content-Disposition`，三条都不命中）。口径在客户端仓库
  `tool/upload_to_oss.mjs` 的 `ALIAS_PREFIX`，网页端镜像在 `lib/client-assets.mjs` 的
  `clientApkAliasKey`——改一处必须改另一处。
- **下载在浏览器里完成**：`components/download/apk-download.jsx` 用 `fetch` 直连 OSS
  （桶的 CORS 必须放行本站的 GET，见 `scripts/oss-cors.mjs`），读成 Blob 后
  `<a download="<资产名>">` 存盘。文件名只能这样给——跨源链接的 `download` 属性、
  302 跳转过去都会被浏览器忽略（实测）。
- 代价：整包在内存里过一遍（约 32MB）。换来的是国内用户直连成都 OSS 的速度，
  以及完全不依赖中间服务器；失败时给 `.bin` 直链兜底。
- 清单里 APK 的 `url` 指向 `https://myquiz.cn/download/apk?name=<资产名>&v=<tag>`：
  这是**自动下载落地页**（加载即触发上面的流程），给已安装客户端的「去下载」用。
  **旧客户端不用重发版**，清单改掉就生效。Windows 资产仍是 OSS 直链。
- `/api/client/download` 留作**过渡期 302**：v2.9.2 的清单还指着它，部署后老客户端
  会被送到落地页（302 不碰 OSS，所以在连不上 OSS 的函数里也能用）。清单回填后
  只剩收藏的旧链接会来。
- `/download` 页整体挪到客户端组件（`components/download/download-page-client.jsx`）：
  清单也由浏览器取，避开上面那个"服务端读 OSS 会失败"的坑；页面因此是纯静态。

### 资产名、版本号与上线顺序

- **资产名两端逐字一致**（都不带版本号）：网页端 `lib/client-assets.mjs` 的
  `APK_ASSET` / `WIN_SETUP_ASSET` / `WIN_ZIP_ASSET`，与客户端仓库
  `mianyang_quiz/tool/upload_to_oss.mjs` 推上去的名字是同一套。改一处必须改另一处，
  否则页面点下去是 404。
- **版本号三处同源**：客户端构建注入的 `APP_VERSION`、`client/latest.json` 的 `tag`、
  网页端下载页显示的版本徽标都来自同一个 git tag。客户端个人资料页会显示
  「当前版本 vX.Y.Z」，更新检查与网页端读同一份清单。
- **上线顺序**：客户端打 tag → GitHub Release（留档）→
  `release.yml` 的「上传到阿里云 OSS」把 `assets/*` 推到 `client/`（APK 另带 `.bin` 副本）
  并写 `client/latest.json`（缺 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` 直接失败，
  避免"GitHub 发了、下载页还停在旧版本"）→ 网页端 1 分钟内跟上（revalidate 60）→
  客户端启动时读同一份清单检查更新。
- ⚠ `release` job 的第一步必须是 `actions/checkout@v4`：它要执行
  `tool/upload_to_oss.mjs`。只下载 artifact 的 job 里没有这个文件
  （2026-10-21 v2.8.3 因此报 `MODULE_NOT_FOUND`；旧流程缺 secrets 时会跳过，所以一直没暴露）。
- `latest.json` 结构：`{ tag, publishedAt, assets: [{ name, size, sha256, url }] }`；
  资产 `url` 都带 `?v=<tag>` 绕开 CDN 旧缓存。
- **给已经发布的那一版补副本 / 改清单**：`node scripts/client-apk-alias.mjs`
  （只加 `.bin` 副本，随时可跑）；网页端部署**之后**再加 `--manifest` 才会改线上清单——
  脚本会先探测 `/download/apk`，没上线就拒绝，免得已装客户端拿到 404 的更新地址。
  2026-10-27 用它接过 v2.9.1；2026-10-29 用它把清单从失效的服务端路由切到落地页。
- 补历史版本（本机）：`node mianyang_quiz/tool/upload_to_oss.mjs --dir <目录> --tag vX.Y.Z`
  （`--site-base` 默认 `https://myquiz.cn`；`--public-base` 只影响 Windows 前缀），
  脚本会校验 `.bin` 副本的长度并写 latest.json。
- 2026-10-21 曾尝试把 `download.myquiz.cn` 绑到大陆 bucket，因备案问题未成功；
  Cloudflare 上还留着 TXT `_dnsauth.download` 与 CNAME `download`，不再使用时可以删掉。
