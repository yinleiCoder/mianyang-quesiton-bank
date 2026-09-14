"use client"

// DeepSeek 设置面板（**内联，不是弹窗**）：密钥 + 模型。
//
// 为什么不用对话框：这是「没配就不能用」的前置条件，做成弹窗会被人关掉后找不回来。
// 内联放在页面顶部，未配置时整块高亮、其余步骤禁用；配置后就收成一行状态。
//
// 密钥只存在使用者自己的浏览器（localStorage），请求从浏览器直达 DeepSeek。
// 所以必须说清两件事：费用由填密钥的人承担；同一台电脑的其他人能看到它。

import * as React from "react"
import { toast } from "sonner"
import {
  setDeepSeekKey,
  clearDeepSeekKey,
  setDeepSeekModel,
  looksLikeKey,
  normalizeKeyInput,
  getDeepSeekKey,
} from "@/lib/deepseek-prefs"
import { DEEPSEEK_MODELS, testDeepSeekKey } from "@/lib/deepseek"
import { useDeepSeekPrefs } from "@/lib/use-deepseek-prefs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { KeyRoundIcon, Trash2Icon, CheckCircle2Icon, Loader2Icon } from "lucide-react"

export function DeepSeekSettingsPanel({ onChange, compact = false }) {
  // 设置只在浏览器里，读到之前不能渲染真实分支（否则 hydration 对不上）
  const { masked: saved, model, ready, refresh } = useDeepSeekPrefs()
  const [value, setValue] = React.useState("")
  const [editing, setEditing] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [tested, setTested] = React.useState(null) // {ok, message}

  function save() {
    const v = normalizeKeyInput(value)
    if (!v) return toast.error("请粘贴密钥")
    if (!looksLikeKey(v)) {
      // 不硬拦：格式将来可能变，只是提醒一句
      toast.warning("这看起来不像 DeepSeek 的密钥（通常以 sk- 开头），仍会保存")
    }
    const ok = setDeepSeekKey(v)
    setValue("")
    setEditing(false)
    // 隐私模式下写不进去也别把人挡住：本次会话内仍可用，只是刷新后要重填
    toast[ok ? "success" : "warning"](ok ? "密钥已保存在本机浏览器" : "浏览器不允许保存，本次可用，刷新后需重填")
    refresh()
    onChange?.()
  }

  // 用一次极小的真实请求验证密钥：比"跑到第 3 页才发现 401"划算得多。
  // 输入框有值就测输入框里的；没有就测已保存的那把（界面上显示的是打码值，原文从存储里取）
  async function test() {
    const v = normalizeKeyInput(value) || getDeepSeekKey()
    if (!v) return toast.error("请先粘贴密钥再测试")
    setTesting(true)
    setTested(null)
    try {
      const r = await testDeepSeekKey({ apiKey: v, model })
      setTested(r)
      if (r.ok) toast.success("密钥可用，模型也能调通")
      else toast.error(r.message)
    } finally {
      setTesting(false)
    }
  }

  function clear() {
    clearDeepSeekKey()
    setEditing(true)
    toast.success("已清除本机保存的密钥")
    refresh()
    onChange?.()
  }

  function pickModel(v) {
    setDeepSeekModel(v)
    refresh()
    onChange?.()
  }

  // 挂载前：服务端与客户端首帧都渲染这个占位，避免"未配置↔已配置"的闪烁与不一致
  if (!ready) {
    return <div className="h-14 animate-pulse rounded-xl border bg-muted/40" />
  }

  const current = DEEPSEEK_MODELS.find((m) => m.value === model) ?? DEEPSEEK_MODELS[0]

  // 已配置且不是编辑态：收成一行
  if (saved && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
        <CheckCircle2Icon className="size-4 shrink-0" />
        <span>
          解析密钥已配置（<b>{saved}</b>）· 模型 <b>{current?.value}</b>
        </span>
        <span className="text-xs text-emerald-700">
          费用按用量记在你的 DeepSeek 账号上；请求从你的浏览器直达 DeepSeek，不经过本站服务器
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            更换
          </Button>
          <Button size="sm" variant="ghost" onClick={clear}>
            <Trash2Icon className="size-3.5" />
            清除
          </Button>
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
        <KeyRoundIcon className="size-4" />
        需要先配置你自己的 DeepSeek 密钥
      </div>
      <p className="text-xs text-amber-800">
        本功能不提供公共密钥：解析由 DeepSeek 完成，费用由使用者承担（一道题约 ¥0.0035，一份 200 页的卷子约
        ¥1~2）。密钥<b>只保存在你这台电脑的浏览器里</b>，请求从浏览器直达 DeepSeek，不经过本站服务器。
      </p>
      {!compact && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="ds-key">密钥（sk-…）</Label>
            <Input
              id="ds-key"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="粘贴你在 platform.deepseek.com 创建的 API Key"
            />
            <p className="text-xs text-amber-800">没有密钥？到 DeepSeek 开放平台注册并创建，按量扣费。</p>
          </div>

          <div className="space-y-1.5">
            <Label>使用模型</Label>
            <select
              value={model}
              onChange={(e) => pickModel(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
            >
              {DEEPSEEK_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-amber-800">{current?.hint}</p>
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={!value.trim()}>
          保存密钥
        </Button>
        <Button size="sm" variant="outline" onClick={test} disabled={testing || (!value.trim() && !saved)}>
          {testing ? <Loader2Icon className="size-4 animate-spin" /> : null}
          测试密钥
        </Button>
        {saved && (
          <>
            <span className="text-xs text-amber-800">当前已保存 {saved}</span>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
          </>
        )}
      </div>
      {tested && (
        <p className={`text-xs ${tested.ok ? "text-emerald-700" : "text-rose-700"}`}>
          {tested.ok ? "✓ 密钥可用（模型也能调通）" : `✗ ${tested.message}`}
        </p>
      )}
      <p className="text-xs text-amber-800">
        提示：密钥保存在本机浏览器中，<b>同一台电脑的其他人也能看到它</b>，公用电脑用完请点「清除」。
        怕粘错可以点「测试密钥」——它会发一次极小的请求（花不到一分钱）验一下。
      </p>
    </div>
  )
}
