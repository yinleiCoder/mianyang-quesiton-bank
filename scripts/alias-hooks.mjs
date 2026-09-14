// node 的模块解析钩子：把 `@/xxx` 映射到仓库根目录（与 jsconfig.json 的别名一致）。
//
// 为什么需要它：lib/ 下的纯函数模块（import-pipeline / deepseek）在 Next 里用 `@/` 互相引用，
// 而 node 不认这个别名。有了钩子就能用 node 直接跑纯函数自检（npm run test:import），
// 不必为测试另建一套打包流程——本项目没有测试框架。

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = path.join(root, specifier.slice(2))
    // Next/打包器允许省略扩展名，node 的 ESM 不允许——这里替它补上（.js 优先，其次目录 index）
    const hit =
      [target, `${target}.js`, path.join(target, "index.js")].find(
        (p) => fs.existsSync(p) && fs.statSync(p).isFile()
      ) ?? target
    return nextResolve(pathToFileURL(hit).href, context)
  }
  return nextResolve(specifier, context)
}
