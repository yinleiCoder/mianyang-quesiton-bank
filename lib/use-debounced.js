"use client"

// 输入防抖：搜索框每敲一个字就重算一遍、每敲一个字就打一次库，都是白花。
//
// 为什么不用 useDeferredValue：它解决的是"渲染优先级"（把慢的那次渲染让出去），
// 不是"少算几次" —— 这里要的是后者（模糊匹配本身很快，但乘上每键一次就不划算了）。
// 服务端搜索那几处（题目选择器）本来就是 setTimeout 手写防抖，这里统一成 hook，
// 客户端模糊搜索一律走它。
import { useEffect, useState } from "react"

export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
