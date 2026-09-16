"use client"

// DeepSeek 设置（密钥 + 模型）的响应式读取钩子。
//
// **不能在 useState 初始化里读 localStorage**：服务端渲染时读不到（渲染成"未配置"），
// 客户端首帧读到了（渲染成"已配置"），两边 HTML 不一致 → React 报 hydration 失败。
// 这里的做法是：首帧一律按"还没读到"渲染（与服务端一致），挂载后再去读并发起重渲染。
// 调用方应当在 !ready 时渲染骨架或保持禁用态，避免"先显示未配置、再跳成已配置"的闪烁。

import { useCallback, useEffect, useState } from "react"
import { getDeepSeekKey, getDeepSeekModel, maskKey } from "@/lib/deepseek-prefs"

export function useDeepSeekPrefs() {
  const [masked, setMasked] = useState("")
  const [model, setModel] = useState("")
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setMasked(maskKey(getDeepSeekKey()))
    setModel(getDeepSeekModel())
    setReady(true)
  }, [])

  const refresh = useCallback(() => {
    setMasked(maskKey(getDeepSeekKey()))
    setModel(getDeepSeekModel())
    setReady(true)
  }, [])

  return { masked, hasKey: Boolean(masked), model, ready, refresh }
}
