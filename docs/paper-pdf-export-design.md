# 试卷导出 PDF：方案与已查证的事实

> 状态：**方案已定，代码未动**（2026-10-08）。用户选了"子集字体"这条路。
> 这份文件存在的理由同 `pending-design.md`：结论是问出来的，不写下来下次要重新问一遍。

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
  没有导出按钮。

## 三、决定：GB2312 子集字体（约 2~4MB）

```
一个 OFL 授权的中文字体（单文件 TTF/OTF）
  └─ 用 subset-font（npm，harfbuzzjs 的 WASM 封装，纯 JS 可跑）
       切出「ASCII + 常用标点 + GB2312 全集（6763 字）」
         └─ 产物提交进 public/fonts/（约 2~4MB），导出时按需加载
```

**为什么不是完整字体（约 10MB）**：试卷用字跑不出 GB2312，而 10MB 要进仓库 + 首次导出全下载。
**为什么不是 CDN 拉字体**：本仓的部署与用户都在国内，CDN 可用性是这个项目反复踩过的坑
（见 MEMORY 里的 Vercel / supabase.co SNI 两条）——字体这种"导出必须成功"的东西不能挂在网络上。

### 待办清单（下一轮直接照做）

1. **挑字体**：要 OFL/免费商用 + 单文件。
   候选：思源黑体 SC（Source Han Sans，OFL）/ Noto Sans SC（OFL，与思源同源）/
   阿里巴巴普惠体（免费商用）；**逐个核对授权条款并把结论写回本节**。
2. **生成 GB2312 字符集**：Node 24 自带 full-icu，`new TextDecoder("gbk")` 可以直接
   把 `0xB0A1~0xF7FE` 的合法双字节解出来，不用额外装编码表。
3. `npm i -D subset-font`，写 `scripts/build-cjk-subset.mjs`（一次性脚本，
   **产物入库、脚本入库、原字体不入库** —— 原字体 10MB 没必要跟着仓库走）。
4. `lib/pdf-fonts.js`：`Font.register({ family: "CJK", src: "/fonts/xxx-subset.ttf" })`，
   **动态 import**：不点导出不加载。
5. `components/papers/paper-pdf-document.jsx`：用 `@react-pdf/renderer` 的
   `Document/Page/View/Text` 排版（题干、选项、分值；**不含答案**，答案版另给一个入口，
   与 `app/print/paper/[id]/answers` 同口径）。
6. 导出按钮放在试卷成绩页与打印页（`pdf()` 方法 + `BlobProvider` 二选一，
   实现时看哪个在 Next 16 里更稳）。
7. 验证：导出一份**含中文题干、含图片占位 `[[图1]]`、含公式**的卷子，
   确认字形不缺、分页正常、文件大小可接受。

## 四、要注意的坑（写在这里免得重踩）

- **图片**：题干里的 `[[图1]]` 在 HTML 里是就地渲染的图片；react-pdf 拿不到 DOM，
  需要把图片 URL 换成 `Image` 组件（且要处理 CORS / OSS 直链）。**这一条最容易漏**，
  第一版可以先把图占位成一行文字说明，别让导出直接失败。
- **答案泄漏口径**：试卷 PDF 默认**不带答案**（与 0052「答案只在出分后下发」同精神，
  学生也可能下载试卷）。
- 导出是**纯客户端**动作（与 AI 分析同一条路：不经过服务器、不占函数时长），
  字体与库都走动态 import。
