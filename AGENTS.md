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

自检：`npm run test:pdf`（在 node 里渲染真 PDF 再用 pdfjs 抽回文字核对，37 项断言）；
浏览器端用 `/dev-pdf-export` 与 `/dev-approval-flow` 两个夹具页（都不需要登录）。

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

## 客户端下载：Windows 走 OSS，APK 走 gh-proxy（2026-10-21 起）

GitHub release 资产国内直连不可用；自家成都 OSS 快。分工：

- `client/latest.json` 与 Windows `setup.exe` / `zip` 走阿里云 OSS；
- **APK 走 gh-proxy 加速**（`NEXT_PUBLIC_GH_PROXY` / Flutter `Env.ghProxy`，
  默认 `https://gh-proxy.com/`）。原因是阿里云不允许 `.apk` 从默认域名
  （`*.aliyuncs.com`）分发，而绑定自定义域名要求大陆 ICP 备案；`myquiz.cn`
  目前查不到有效备案，这条路短期走不通。

### .apk 的线路约定

- 页面/客户端从 OSS 清单拿 `tag` 与 SHA-256，再用 **tag + 固定资产名**拼：
  `${GH_PROXY}https://github.com/yinleiCoder/mianyang-quiz/releases/download/<tag>/<name>`。
  **不要用 `latest/download`**：清单已经告诉用户是哪个版本，用 latest 会出现
  "页面显示 v2.8.1、下到 v2.8.0" 的漂移。
- 清单里 APK 的 `url` 通常为 `null`；若将来给桶绑了自定义域名并设置
  `CLIENT_OSS_PUBLIC_BASE`，清单里的 OSS `url` 会优先，APK 自动改走 OSS。
- 换 gh-proxy 节点只改环境变量/`Env.ghProxy`，不要把代理地址散落在组件里。

### 资产名、版本号与上线顺序

- **资产名两端逐字一致**（都不带版本号）：网页端 `app/download/page.jsx` 的
  `APK_ASSET` / `WIN_SETUP_ASSET` / `WIN_ZIP_ASSET`，与客户端仓库
  `mianyang_quiz/tool/upload_to_oss.mjs` 推上去的名字是同一套。改一处必须改另一处，
  否则页面点下去是 404。
- **版本号三处同源**：客户端构建注入的 `APP_VERSION`、`client/latest.json` 的 `tag`、
  网页端下载页显示的版本徽标都来自同一个 git tag。客户端个人资料页会显示
  「当前版本 vX.Y.Z」，更新检查与网页端读同一份清单。
- **上线顺序**：客户端打 tag → **GitHub Release**（gh-proxy 的上游必须先存在）→
  `release.yml` 的「上传到阿里云 OSS」把 `assets/*` 推到 `client/` 并写
  `client/latest.json`（缺 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` 直接失败，
  避免"GitHub 发了、下载页还停在旧版本"）→ 网页端 1 分钟内跟上（revalidate 60）→
  客户端启动时读同一份清单检查更新。
- `latest.json` 结构：`{ tag, publishedAt, assets: [{ name, size, sha256, url }] }`；
  Windows 的 `url` 带 `?v=<tag>` 绕开 CDN 旧缓存。
- 补历史版本：本机跑
  `node tool/upload_to_oss.mjs --dir <目录> --tag vX.Y.Z [--public-base https://<域名>/client]`，
  脚本会校验上传后的长度（APK 在默认域名上跳过长度回读）并写 latest.json。
- 2026-10-21 曾尝试把 `download.myquiz.cn` 绑到大陆 bucket，因备案问题未成功；
  Cloudflare 上还留着 TXT `_dnsauth.download` 与 CNAME `download`，不再使用时可以删掉。
