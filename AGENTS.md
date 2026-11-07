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

### Android 安装包发哪个 ABI（2026-11-02 定案）

**下载页默认下发 `mianyang_quiz-android.apk`（arm64-v8a），并提供一条显眼的
「32 位版」链接指向 `mianyang_quiz-android-armv7.apk`（armeabi-v7a）。**

两边的可装性是**不对称**的，这决定了怎么选：

| 设备 | armv7 包 | arm64 包 |
|---|---|---|
| 32 位 ARM 真机（老手机、千元机） | ✅ | ❌「应用未安装」 |
| 64 位 ARM 真机 | ✅ | ✅ |
| 64 位-only 系统（Pixel 7 起那批） | ❌ | ✅ |
| x86_64 模拟器 | ❌ | ❌ |

**为什么默认给 arm64**：armv7 的覆盖面更大（32 位 + 64 位真机通吃），但**用户反馈里
没有"装不上"这一类**——唯一的硬信号（闪退）全在 Windows，与 ABI 无关。没有证据说
32 位用户成规模，就先给**性能更好**的那份，32 位由页面上的备用链接兜底。

**代价要说清楚**：32 位手机点主按钮会装不上，而报错只有一句「应用未安装」，
不告诉任何人该换哪个文件——所以那条「32 位版」链接必须显眼，不能藏进脚注。

**更新永远不会跨 ABI**：客户端的更新检查按**自己实际在跑的 ABI** 选包
（`mianyang_quiz/lib/utils/android_abi.dart`，从 `/proc/self/maps` 读出来），
所以网页端默认发哪份，都不影响"装的是 A、更新推的是 A"。

**资产名必须逐字一致**（`release.yml` 的「规整资产名」里定的）：

| 资产名 | ABI | 给谁 |
|---|---|---|
| `mianyang_quiz-android.apk` | arm64-v8a | **默认下发**：64 位真机 |
| `mianyang_quiz-android-armv7.apk` | armeabi-v7a | 32 位老设备（页面上的「32 位版」链接） |
| `mianyang_quiz-android-x86_64.apk` | x86_64 | 模拟器 |

**三处必须同时改**（改一处就是"装的是 A、更新推的是 B"）：

1. 网页端 `lib/client-assets.mjs` 的 `APK_ASSET`（下载页按钮 + 落地页默认值）；
2. 客户端 `mianyang_quiz/lib/utils/android_abi.dart` 的 `assetByAbi`（ABI → 资产名）；
3. `mianyang_quiz/.github/workflows/release.yml` 的资产名映射注释与 Release 说明。

`APK_ALIAS_ASSETS` 三个名字**都要留着**：它是 `/download/apk` 落地页 `?name=` 的
白名单，而线上清单对三个名字都发过链接，漏一个，收藏的旧链接就变 404。

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

## 试卷改版后的成绩：旧版成绩不迁移、不重算（2026-11-02 口径反转）

2026-10-29 曾按「发布新版时把旧交卷迁到新版、按新版答案重算」实现（0115 触发器）。
**2026-11-02 用户改口**：发布新版大多是某道题有问题，**不应该影响旧版的考试成绩**。

现在的口径：

- **发布触发器已停用**（`trg_papers_rescore_on_publish`，`tgenabled='D'`）。
  发布新版只新增版本，不迁移、不重算旧场次；旧场次留在原版本，成绩原样保留。
- **成绩榜跨版本合并，每人取最新一次官方成绩**（0118 的 `paper_leaderboard`）。
  旧版成绩保留；新版考过就以新版为准。`class_exam_results` 同样每人每卷取最新一次。
- **试题分析仍只绑定当前入库版本**（逐题分析必须对应一份卷面），旧版场次只在
  试题分析页签计为 `other_version_skipped`。
- `rescore_attempts_for_version` 保留只为手工修复，**不要再挂回发布触发器**。
- 0115 草稿期试过「一版一张榜 + 版本切换器」（`resolve_paper_version` + `p_version_id`），
  已废弃；现在不需要版本切换，也不按版本分榜。

⚠ **24年单招的数据事故**：0115 第一版草稿（先 `delete from exam_answers` 再读旧答案）
在 2026-10-29 13:14 UTC 左右把 120 场官方成绩的 7080 条作答清空并重判成 0 分；
autovacuum 在 13:15 UTC 回收了旧行，heap 里已无法恢复。只能从 Supabase 备份/PITR
恢复到 2026-10-29 13:14 UTC 之前，再按 `attempt_id` 回填 `exam_answers`/`exam_attempts`。
这次事故与 2026-11-02 的口径反转无关；反转只是为了不再发生同类迁移。

## 班级 AI 报告用学生真名（2026-11-03 口径反转）

2026-10-24 的初版把错答名单做成「学生N」编号（0088/0113 的隐私口径）。
**2026-11-03 用户明确改口**：班级 AI 报告不匿名，**直接用学生真名**。

- 迁移 `0127_class_ai_real_names.sql` 只改 `_class_ai_data` 的输出：
  `students[].label`、`options[].students`、`wrong[]`、`samples[].student`、
  `sub_samples[].student` 全部换成 `profiles.name`。
- **内部 join 仍用「学生N」label**（同名学生不会互相串数据），只有发给模型/页面的
  JSON 换真名；改名时别把内部 label 一起改掉。
- 提示词（`lib/ai-report-prompt.js`）要求模型**只使用数据里出现的姓名**，不要猜、不要编造；
  改完跑 `npm run test:ai-report`。`lib/lesson-plan-prompt.js` 允许沿用报告里的姓名。
- 旧报告会因 payload 指纹变化自动变 stale（页面提示重新生成），这是预期行为。

## 展示页与「软件架构讲解」分组（2026-11-05）

侧栏有三个分组：**导航 / 管理台 / 软件架构讲解**。最后一个只放只读展示页，
**不做角色分叉**（学生和教师也要看得见）—— 别把它并进 `管理台` 那个
`isAdmin || isSchoolAdmin` 的闸门里。

- 五项：`/showcase/architecture`、`/showcase/animation`、`/showcase/scheduler`（科学抽题算法动画）、
  `/showcase/promo`、`/showcase/algorithms`。
- 标签三处同源：`components/app-sidebar.jsx` 的 `useNavItems`、`lib/breadcrumbs.js` 的
  `SHOWCASE_PAGES`、各页 `PageHeader`。改一处要改另外两处（breadcrumbs 漏登记会让整条空白）。
- Remotion 只在浏览器里跑（`remotion` + `@remotion/player`，**没有** cli/bundler/renderer）：
  组合 → `*-video.jsx`，播放器 → `"use client"` 的 `*-player.jsx`，
  再由 `*-player-lazy.jsx` 以 `dynamic(ssr:false)` 包一层。Server Component 不能直接 import remotion。
- `components/showcase/primitives.jsx` 是两套动画共用的舞台原语（StageGrid / SceneShell /
  EnterCard / Chip / NodeCard）；动画专用原语放在各自目录下。
- **深链**：`/showcase/scheduler?scene=<id>`，章节 id 见 `lib/showcase-scheduler.js` 的
  `SCHEDULER_SCENES`。Flutter 首页四张原理卡片（`science_note.dart`）点的就是它；
  `proxy.js` 必须把查询串一起塞进登录回跳的 `next`，否则登录后落不到章节。
- 动画里的数字**不是编的**：`lib/showcase-scheduler.js` 用 `lib/practice-scheduler-reference.js`
  的 FSRS-6 / BKT 公式现算。改算法或改文案跑 `npm run test:showcase`。

顺带：`lib/algorithm-notes.js` 的 BKT / FSRS 两条与 `lib/showcase-scheduler-notes.js`
是**互相引用**关系，不要把同一段解释复制两份。

## OSS 流量与 CDN（2026-11-05：只出方案，未改代码）

方案与实测数据在 `docs/oss-cdn-optimization.md`。三条最容易复发的：

- **图片压缩早就做了**（`lib/oss-url.js` 的 `x-oss-process`），别再重复优化；
  真正的浪费是**对象没有 `Cache-Control`**，回访反复回源。
- **`myquiz.cn` 没有有效 ICP 备案**，所以阿里云 CDN 与 OSS 自定义域名都开不了。
  现在能用是因为网页在 Vercel 香港、媒体走 OSS 默认域名（都免备案）。
- **别把 OSS 挂 Cloudflare**：大陆会被调度到境外节点，且 `supabase-proxy/README.md` 已写明。
- 切 CDN 时：媒体地址只改 `NEXT_PUBLIC_OSS_PUBLIC_HOST`；
  **签名下载继续签桶自己的域名**（`app/api/materials/download/route.js:63-64`）。

## 交卷前的作答跨设备同步（2026-11-06，0144）

**考试与练习「还没交的作答」都存服务端了**，换台设备 / 关掉软件再打开都能接着答。
两条通道只装草稿，**不碰统计口径**（交卷仍写 `exam_answers` / `practice_answers`）：

| 场景 | 落点 | RPC | 客户端 |
|---|---|---|---|
| 考试 | `exam_attempts.draft_answers` | `save_exam_answers` / `get_exam_drafts` | 本机 `exam.draft.*` 兜底 + `ExamDraftBuffer`（800ms 节流） |
| 练习 | `practice_sessions.draft_answers` | `save_practice_progress`（也登记 `mode`） | `PracticeRunner`，只对批量 / 顺序模式发 |

**考试离开页面会暂停计时**（2026-11-06 用户口径，后来又明确了一次）：
`exam_attempts.remaining_ms` 冻结剩余毫秒，读考试时（`get_my_exam_attempt` /
`start_exam_attempt` 调 `_resume_exam_attempt_if_paused`）用 `now + remaining_ms`
换回一个新截止时刻。客户端只在 `ExamPage.dispose` 发一次 `pause_exam_attempt`。

⚠ 三条边界：

- **切后台 / 回前台不停表**：用户明确要求"时间依然计时"。只 flush 草稿，
  不要动 deadline；`didChangeAppLifecycleState` 里除了草稿不要加别的事。
- **恢复必须挂在读路径上**：旧客户端不会调 resume，它拿到的 `deadline_at`
  还停在暂停那一刻，倒计时一进来就归零，会**当场把卷子交掉**。
  `get_my_exam_attempt` 因此从 `stable` 改成了 volatile，别改回去。
- **用时 = 总时长 − 剩余**（`ExamClock.elapsedOf`），不能用 `now - started_at`：
  隔天回来会被算成"答了 10 小时"。

五条别再踩的：

- **逐题合并，不是整卷覆盖**：客户端只发改过的那几道，服务端 `||` 合并，空对象 = 删除该题。
  整卷覆盖会让两台设备互相盖掉对方刚写的答案。
- **考试的两份草稿按时刻合并**：本机 `exam.draftAt.<id>` 与服务端 `draft_updated_at` 比，
  本机更新才覆盖；否则服务端优先、本机只补服务端没有的题（断网时写的）。
- **考试用时不能再按墙钟差算**：`now - started_at` 会把"离开一晚上"算成答了 10 小时。
  用 `ExamClock.elapsedOf(总时长)` = 总时长 − 剩余；截止时刻缺失时才退回墙钟。
- **练习方式必须存在会话上**（`practice_sessions.mode`）：0144 之前只存在客户端，
  于是「继续练习」永远按即时练习重开——批量练习会被逐题提交，顺序讲练更违反 0090。
  开练时 `startPracticeFlow` **await** 一次 `save_practice_progress` 再进页面。
- **即时练习不走草稿通道**：它每答一题就走 `submit_practice_answer`，再存草稿是重复。
  批量（交卷前不提交）与顺序讲练（0090 一个答案都不交）才需要；它们的
  `answered_count` 由 `save_practice_progress` 按草稿数维护（首页「继续练习」卡读它）。

## AI 智能解析：图片队列 + 答案区（2026-11-06，0146）

两件事一起做的：**图片可以一次传多张**，**答案可以单独传一份**。都只改浏览器侧
（源文件仍然不上传），数据库只加两列 + 三个小函数。

### 图片：队列与切图

- 「多图」原本就有（一张 = 一页），坏在**看不见**：没有缩略图/顺序/追加，续跑时
  `rePick` 只收一张。现在 `components/import/image-queue.jsx` 管缩略图与顺序。
- **队列只在建任务之前可编辑**。页号写进 `import_job_pages` 之后再删/挪一张，
  第 7 页会静默换成另一张照片；跑批页的重选一律 `editable={false}`，只按张数校验。
- **续跑必须一次选齐**：`page_no` 是 `files` 的下标（`buildPagePayload` 的 image 分支）。
  少一张，后面每一页都错位——所以 `rePick` 在数量不足时直接拒绝，不弹确认。
- **上传的图必须切片**（`lib/image-client.js`）：宽度归一到 A4@180dpi（1489px），
  每片 ≤1.6M 像素、最多 8 片。上游会把大图缩到约 800×800，整页照片不切就是糊的
  （PDF 路径早就按同一口径切 1×2，见 `lib/pdf-client.js:194-200`）。
- 片数由 `planImageTiles` 的几何保证——**不要再写 `images.slice(0, 8)` 那种静默截断**，
  它会让页底整块看不见而界面毫无提示。
- 解码改成**按需**（选完只存 `File[]`，`tilesFor` 带 2 条缓存）：选 30 张就先把 30 份
  dataURL 全读进内存，是以前卡顿的来源。

### 答案区：答案键 + 另一份答案

- 形状：`import_jobs.answer_key`（题号 → 答案文本 + 逐页进度）与
  `import_job_items.answer_alt`（与主答案不一致的那一份）。**answer_alt 绝不进 content**——
  `import_questions_draft` 会把 content 原样抄进 `question_versions`。
- 流程：跑题目页**之前**先把答案区读成键（`parseAnswerSource`，逐页落库、`pages[]` 记成败、
  `parsed_at` 只在全部成功时打）。已解析的题目页补不回来，所以顺序不能反。
- 答案键的**文本**放进 user 消息的**最前面**（`buildAnswerKeyBlock`）：system + 答案键
  是每页共享的缓存前缀。规则写在 `ANSWER_KEY_TAIL`，`SYSTEM_PROMPT` / `USER_TAIL` /
  `PAPER_TAIL` **一个字都没改**（它们必须逐字节稳定）。
- **一切以 `ctx.hasAnswerKey` 为闸**：没有键时 `answer_source:"key"`、`answer_alt`、
  两个新 flags 一律不产生。这同时是「迁移没跑」的降级路径——老 CHECK 不会被撞。
- 冲突**只对客观题标**（选择/判断/填空）。简答题措辞不同是常态，见一条标一条，
  这个徽标很快就会被无视（同上一节「查重」的教训）。主观题仍保留两份，只是不打标记。
- 主答案默认放**答案区**那份（2026-11-06 用户选定），另一份进 `answer_alt`，
  预览页「改用这一份」走 `import_switch_item_answer`（**互换**）。
  用 `import_update_item` 代替会把另一份永久丢掉，那不是切换。
- 答案区的 Word 用 `docxBatches(doc.paragraphs, { perBatch: 40, maxChars: 8000 })`：
  答案是一行一题，默认 5 题一批会把 200 行答案切成 40 次调用。

### 三条别再踩的

- **不改 `import_save_page`**。要多写一列就用包装函数 `import_save_page_with_alts`：
  它调原函数再补一次 UPDATE，原函数的租约/幂等/人工修改守卫一条没变。
- **p_alts 的 seq 是 `p_items` 的数组下标**，不是 `it.seq`——`normalizePage` 的 seq
  赋值在去重之前，两者会错位，错位就把答案挂到别的题上。
- **新列读取要能降级**：`loadImportJob` / `loadJobItems` 读不到 `answer_key` /
  `answer_alt` 时退回旧列（`lib/import-jobs.js` 的列阶梯），`loadAnswerZoneSupport`
  探一下 0146 在不在、不在就整个隐藏答案区入口。一条辅助信息不该让整页打不开。

自检：`npm run test:import`（答案键归一/去重、`hasAnswerKey` 闸门、冲突判定、
切图几何、截断抢救）。2026-11-06 用真模型联调过：答案区 7 条全部抽出，
故意写错的那道题主答案取答案区的、AI 的进 `answer_alt` 并标 `answer_conflict`。

## AI 解析任务按教师隔离（2026-11-06，0147）

AI 智能解析的任务**绑定创建它的老师**，不同老师完全隔离（0147）。0034 当初把读放宽成
「本人 / 本校学校管理员 / 系统管理员」，0147 收回了：解析中的整卷内容、答案区和没定稿的
题目不该给同校其他人看，学校管理员与系统管理员也一样。写路径从 0035 起本来就只认创建者。

改可见性时**别只改 `import_jobs` 的策略**：`import_job_pages` / `import_job_items` /
`import_job_sections` 三张表的读策略都走 `is_import_job_owner()`，那个函数才是主开关，
`import_find_similar` 的守卫也用它。`import_jobs` 自己的策略是内联展开的，需要单独改。

## 阅卷分摊：学校 + 专业公共池（2026-11-07，0148）

0124 起填空/综合题全部人工判分，一份全市卷的待批场次会全压在试卷作者一个人身上。
0148 把阅卷资格扩成四类（**不改 `is_paper_grader` 的纸级语义**）：

1. 纸级管理员：作者 / 系统管理员 / 试卷归属学校管理员（`is_paper_grader` 原口径）；
2. 考生所在学校的**同专业教师**：教师 `profiles.major_node_id` 与考生相同，或是考生专业的
   祖先（教师挂「计算机类」、学生挂「计算机应用技术」也匹配）；教师未设置任教专业时按
   本校通用阅卷人；考生专业为空时同校教师都可批；
3. 该科目（`papers.course_node_id` 子树）的**教研组长**（考生学校）/**市级专家**（考生学校同市）；
4. **已认领人**：教师调岗/专业变更后，已认领的场次仍能批完。

默认是**公共池认领，不强制分配**：`exam_attempts.claimed_by/claimed_at` 记认领，
第一次给分自动认领（管理员直接批不占池子）；一份答卷同时只由一位老师批。
管理员可按场次改派、把未认领场次一键平均分配（排除试卷作者与操作人），也可释放。

### 三条别再踩的

- **别把新分支塞进 `is_paper_grader`**：它同时是成绩榜/试题分析/质量诊断的纸级权限开关
  （0063 明写）。新口径在 `can_user_grade_attempt(user, attempt)` / `can_grade_attempt(attempt)`；
  `list_exam_attempts_for_paper`、`get_exam_attempt_for_review`、`grade_exam_answer`、
  `finish_exam_grading` 已改用它。
- **RLS 要跟着放**：`exam_attempts` / `exam_answers` 的读策略增加了 `can_grade_attempt`；
  否则公共池教师能打开阅卷页却读不到学生作答。
- **认领是行锁 + 条件更新**：`grade_exam_answer` / `finish_exam_grading` 用 `for update`，
  `claim_exam_grading` 先锁再判；不要改成无锁的 `update ... where claimed_by is null` 单独兜底，
  否则两位老师会互相覆盖同一份卷的分数。

自检：`npm run test:grading`（主观题提示词/验分不变）；SQL 侧用
`select public.can_user_grade_attempt('<teacher_uid>','<attempt_id>')` 核对同校同专业/外校/异专业
三种结果。网页入口：`/grading`（公共池）与 `/papers/[id]/grading`（认领/改派/平均分配）。
