// 注册 jsx-hooks.mjs（node 24 里 --import 只是"执行这个文件"，钩子要显式 register）。
import { register } from "node:module"

register("./jsx-hooks.mjs", import.meta.url)
