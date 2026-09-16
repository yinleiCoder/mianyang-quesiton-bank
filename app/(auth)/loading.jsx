// (auth) 段的骨架：注册页要服务端查一次启用学校列表（1 次往返）才渲染表单，
// 没有边界的话这一下是白屏。骨架落在 (auth)/layout.jsx 的卡片里，形状按表单对齐。
// 登录页没有 await，不会触发这个回退。
//
// ⚠ 必须是 .jsx：本仓库是纯 JS 工程，出现 .tsx 会让 Next 生成不带 paths 的 tsconfig.json，
// 从而顶掉 jsconfig.json 的 `@/*` 映射（见 app/(app)/loading.jsx 的说明）。
export default function AuthLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">加载中</span>
      <div className="space-y-2">
        <div className="mx-auto h-7 w-32 animate-pulse rounded-md bg-muted" />
        <div className="mx-auto h-4 w-56 max-w-full animate-pulse rounded-md bg-muted" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
        ))}
      </div>
      <div className="h-10 animate-pulse rounded-md bg-muted" />
    </div>
  )
}
