// 给 node 用的解析/加载钩子：`@/` 别名（同 alias-hooks.mjs）+ 现场编译 .jsx。
//
// 为什么需要编译 JSX：试卷 PDF 的文档组件（components/papers/paper-pdf-document.jsx）
// 是本次要验的东西，把它排除在测试之外等于没测。node 不认 JSX，所以在加载阶段用
// babel 转一遍——用的就是仓库里已有的 @babel/core（babel-plugin-react-compiler 带的）。
//
// 与 alias-hooks.mjs 分开是刻意的：那个是所有自检脚本共用的解析器，这里多一个编译步骤，
// 让需要它的测试自己 --import，不去改别人脚下的东西。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { transformSync } from "@babel/core"
// eslint-disable-next-line  —— 插件是 CJS，默认导出挂在 default 上
import jsxPlugin from "@babel/plugin-transform-react-jsx"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXTS = ["", ".js", ".jsx", path.join("index.js"), path.join("index.jsx")]

function pick(target) {
  for (const ext of EXTS) {
    const p = ext ? target + ext : target
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {
      // 不存在就试下一个扩展名
    }
  }
  return target
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(pathToFileURL(pick(path.join(root, specifier.slice(2)))).href, context)
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".jsx")) {
    const source = fs.readFileSync(fileURLToPath(url), "utf8")
    const { code } = transformSync(source, {
      filename: fileURLToPath(url),
      babelrc: false,
      configFile: false,
      plugins: [[jsxPlugin, { runtime: "automatic" }]],
    })
    return { format: "module", source: code, shortCircuit: true }
  }
  return nextLoad(url, context)
}
