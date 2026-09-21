"use client"

// 上传进度条。两个上传对话框共用（题目媒体 / 头像、复习资料）。
//
// 为什么值得单独一个组件：资料文档放宽到 2GB 之后，一次上传按分钟计，
// 「转圈 + 按钮禁用」已经不足以让人判断"是在传还是卡死了"。有了字节数，
// 用户能自己看出速度、决定要不要等。
//
// total 拿不到时**不显示假百分比**：宁可只说"上传中"，也不给一个不动的 0%。

function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

export function UploadProgress({ loaded, total }) {
  const known = Number(total) > 0
  const pct = known ? Math.min(100, Math.round((Number(loaded) / Number(total)) * 100)) : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{pct === null ? "上传中…" : `上传中 ${pct}%`}</span>
        {known && (
          <span className="tabular-nums">
            {humanSize(loaded)} / {humanSize(total)}
          </span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={
            pct === null
              ? "h-full w-full animate-pulse bg-primary/60"
              : "h-full bg-primary transition-[width] duration-200"
          }
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
