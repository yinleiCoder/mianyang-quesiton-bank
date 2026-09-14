// 注册上面的解析钩子。node 24 里 `--import` 只是"执行这个文件"，
// 要真正挂上钩子必须显式调 register()（钩子跑在独立的线程里，所以拆成两个文件）。
import { register } from "node:module"

register("./alias-hooks.mjs", import.meta.url)
