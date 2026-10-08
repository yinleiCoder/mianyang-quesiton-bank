# 试卷导出 PDF：方案与已查证的事实

> 状态：**已实现并上线自检**（2026-10-08）。用户选了"子集字体"这条路。
> 这份文件存在的理由同 `pending-design.md`：结论是问出来的，不写下来下次要重新问一遍。
> 实现过程中撞到五颗雷，全都写在第「四」节——**下次改这块先读那一节**。

## 一、需求

网页端能**下载**一份试卷的 PDF（不是现在的"浏览器打印 → 另存为 PDF"）。
Flutter 端已有打印（`printing` 包 + 系统字体），这一条只做网页端。

## 二、查证过的事实（2026-10-08）

- `@react-pdf/renderer@4.9.0` **已装**（package.json）。
- **仓库里没有任何 CJK 字体**：`public/` 只有 `mianyang.svg` 与 `pdfjs/`；全仓唯一的
  字体文件是 Next 自己带的 latin 子集（`.next/**/*.woff2`，每个 10~30KB）。
- **中文必须内嵌字体** —— 浏览器里能用系统字体，react-pdf 不行（它自己排版）。
- `@fontsource/noto-sans-sc` **用不了**：实测 `npm pack --dry-run` 是
  **918 个分片 woff2 / 解包 74.5MB**（按 unicode-range 切给 CSS 的），
  而 react-pdf 的 `Font.register` 要的是**单个文件**。
- 现在的打印路径是 `app/print/paper/[id]/page.jsx`（服务端渲染 + 浏览器打印），
  现在多了一个"下载 PDF"的按钮。

## 三、决定：GB2312 子集字体（实产 2.3MB × 2）

```
Noto Sans SC（OFL 1.1）静态 TTF（400 / 700 各一份，Google Fonts 接口取）
  └─ scripts/build-cjk-subset.mjs（subset-font = harfbuzzjs 的 WASM 封装）
       切出「ASCII + 拼音 + 通用标点 + GB2312 全集」+ **把 U+002D 的字宽改成 0**
         └─ 产物提交进 public/fonts/（每份 2.3MB），导出时按需加载
```

**为什么不是完整字体（10.5MB）**：试卷用字跑不出 GB2312，而 10.5MB 要进仓库 + 首次导出全下载。
**为什么不是 CDN 拉字体**：本仓的部署与用户都在国内，CDN 可用性是这个项目反复踩过的坑
（见 MEMORY 里的 Vercel / supabase.co SNI 两条）——字体这种"导出必须成功"的东西不能挂在网络上。
**为什么是两个文件**：react-pdf 不会自己合成粗体，卷头与题干小标题要真加粗就得真给一份粗体。

### 怎么重建（换字体 / 补缺字时）

```bash
# 1. 取两份 OFL 中文字体的静态 TTF（老 UA 才给 TTF，不给 woff2）
curl -s -H "User-Agent: Mozilla/4.0" "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700"
curl -L -o scripts/.fontwork/Noto-Regular.ttf <上面输出里 400 那个 src>
curl -L -o scripts/.fontwork/Noto-Bold.ttf    <上面输出里 700 那个 src>
# 2. 生成（产物进 public/fonts/，字符集清单进 lib/pdf-font-charset.js）
node scripts/build-cjk-subset.mjs scripts/.fontwork/Noto-Regular.ttf scripts/.fontwork/Noto-Bold.ttf
npm run test:pdf
```

`scripts/.fontwork/` 已进 .gitignore（原字体 10.5MB 不跟着仓库走）。脚本末尾会打印
"要了但字体里没有"的字，缺字请加进 `scripts/cjk-extra-chars.txt` 再跑一遍。

### 文件清单

| 文件 | 职责 |
|---|---|
| `scripts/build-cjk-subset.mjs` | 一次性构建：字符集 + 子集 + 字宽手术 |
| `scripts/cjk-extra-chars.txt` | GB2312 之外的补充字（缺字时的唯一入口） |
| `public/fonts/noto-sans-sc-{regular,bold}.ttf` | 产物，入库 |
| `lib/pdf-font-charset.js` | 生成的字符集清单，给缺字检查用 |
| `lib/pdf-fonts.js` | 字体登记 + 断行回调 + 缺字检查 |
| `lib/pdf-prep.js` | 文字/图片的准备：收图、取图、缩放、连字符替换 |
| `components/papers/paper-pdf-document.jsx` | 文档本体（与 paper-sheet.jsx 同口径） |
| `components/papers/export-pdf-button.jsx` | 按钮：进度、缺字提示、下载 |
| `scripts/test-pdf-export.mjs` | 自检（`npm run test:pdf`），37 项断言 |

## 四、五颗雷（都踩过，都修了）

### 1. 中文**根本不换行**，整段冲出纸面被裁掉

react-pdf 只按**空格**切词，中文没有空格 → 一整段是一个"词" → 一行排完，超出部分
被裁掉。实测一段 100 字的题干：单个文字对象、宽 562pt、页面内容区只有 515pt。
**不报错，PDF 打得开，只是字没了。**

修法：`Font.registerHyphenationCallback(syllablesFor)`（`lib/pdf-fonts.js`）——
把汉字逐字切成"音节"（断行点只可能落在音节边界），连续的西文/数字抱成一团不拆，
并在这里实现**行首/行尾禁则**（"。"不能落在行首、"（"不能落在行尾：把不该分开的字
粘进同一个音节）。自检里用文字的 y 坐标验"确实折成了多行、没有一行越过右边界、
没有一行以句读开头"。

### 2. 每次断行都被插一个连字符

排版引擎在音节边界断行时会**插一个 U+002D**（`@react-pdf/textkit` 的 `insertGlyph`），
宽度写死 5pt，没有开关。中文断行不该有连字符。

修法：**让那个连字符隐形**——构建脚本把字体里 U+002D 的字宽改成 0（hmtx 表手术 +
重算校验和）。正文里真正的连字符（`MY-2026-01`）在组装文字时换成 **U+2011**
（非断连字符：字宽与字形和 U+002D 完全一致，347/1000 em，但不会被引擎插、也不是断行点）。
代价写在这里：从 PDF 里复制文字，断行处会多出一个 `-`（与英文断词 PDF 的表现一致）。

### 3. 页脚**整个消失**：`render` 回调 + `lineHeight` 不能共存

页脚要印页码，只能用 `<Text fixed render={({pageNumber}) => …}>`。实测：
**只要样式链里有 `lineHeight`（自己写的或从 Page 继承的，倍数的或绝对值的都一样），
这段文字就一个都不打印**，不报错、不警告。

修法：行距挂到正文包装层 `<View style={S.body}>`，`page` 上**不写** lineHeight，
页脚作为 Page 的直接子元素、样式里也不碰 lineHeight。`paper-pdf-document.jsx` 的
`page`/`body` 两处注释都标了这条。

### 4. 图片必须是原生字节：**webp 会让整份导出挂掉**

`lib/oss-url.js` 的 `mediaUrl()` 默认给非 GIF 图加 `format,webp`（网页上是对的：7.6MB
的原图压到 38KB）。但 `@react-pdf/image` 只认 **png / jpg / gif / svg** 四种字节，
喂它 webp 是渲染期失败——**不是那一张图没了，是整份导不出来**。

修法两条一起：
- 导出取图时用 `mediaUrl(key, { width: full, raw: true })`（只缩放、不转格式不压质量，
  拿到的还是 png/jpg）。`raw` 是为此新加的开关，默认仍是 webp，网页显示不受影响。
- `lib/pdf-prep.js` 的 `imageBytesKind()` 按**魔术字节**嗅探，认不出来（webp、HTML 错误页、
  别的什么）就在抓取阶段抛错 → 那一张退化成一行说明文字，其余照常导出。

### 5. 图片：OSS 直链要 CORS，抓失败不能让整份导出失败

react-pdf 要拿到图片**字节**（它自己排、自己写 PDF），所以走 fetch → 需要 CORS。
线上放行的来源见 `scripts/oss-cors.mjs`（`myquiz.cn` / `localhost:3000` / `127.0.0.1:3000`）。
本机换端口预览、或 *.vercel.app 预览域名下，图片会抓不到。

修法：`lib/pdf-prep.js` 的 `prefetchImages` 逐张抓成 data URL **并量出宽高**
（PDF 里按比例摆，横图竖图不会被拉变形）；**单张失败只让那一张退化成一行说明文字**，
不连累整份导出。音频/视频/附件在纸上无法呈现，同样退化成一行"请在网页端查看"。

### 附注：`/fonts/*.ttf` 会走一遍 proxy

`proxy.js` 的 matcher 排除了 `svg|png|jpg|…` 但没排除字体，所以每次导出会多两次
`getClaims()`（两个字体文件）。**不要去改那个 matcher**：它上面写得很清楚——cookie 只能
在这一层写，任何收窄都会让令牌刷新无处落盘、表现为用户被静默登出。多两次本地验签
（JWKS 缓存后不打网络）换这个风险，不值。

## 五、几个刻意的取舍

- **答案泄漏**：正卷 PDF 里**没有**答案与解析（不是藏起来，是不进文档），
  与 `app/print/paper/[id]/answers` 同一条安全边界。自检里有断言钉住。
- **缺字不挡流程**：字体装不下 GB2312 之外的字（生僻姓名字最常见），导出前会提示
  "有 N 个字没有字形，导出后会空白"，但**照常导出**——为一两个字挡住整份卷子不值得。
- **两条出口并存**：原来的"打印 → 另存为 PDF"**没有删**。它什么都不用带（浏览器
  自己排版、用系统字体），这条要自己排版、自己嵌字体。各有各的失败模式。
- **纯客户端**：不经过服务器、不占函数时长；react-pdf 与字体都动态 import，
  不点导出就不进任何人的首屏包。
- **排版是两份**：`paper-sheet.jsx`（HTML）与 `paper-pdf-document.jsx`（react-pdf）
  必须一起改。换成"HTML 转 PDF"就得在浏览器里跑排版引擎，中文断行/分页/字体嵌入
  全都得另伺候一遍——重复是刻意接受的代价。
