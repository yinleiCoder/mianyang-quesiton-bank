// (app) 段的兜底骨架。
//
// 为什么必须有：每个页面的第一件事都是 await requireUser()（或 await searchParams），
// 没有 Suspense 边界的话，React 会一直往上找到最近的边界为止 —— 找不到就整棵子树一起等，
// 连 app/(app)/layout.jsx 的外壳都刷不出去。放这个文件等于给每个页面套了一层边界：
// 外壳先出，页面骨架顶上，数据到了再换。
//
// 页面内部若自己包了更细的 <Suspense>，那些边界离数据更近、优先生效，这里只在最外层兜底。
//
// ⚠ 必须是 .jsx，不能写成 .tsx：本仓库是纯 JS 工程（jsconfig.json + components.json 的
// "tsx": false），一旦出现 .tsx，Next 会自动生成一个**不带 paths 映射**的 tsconfig.json，
// 而 tsconfig 的优先级高于 jsconfig —— 结果全站 `@/…` 别名解析全部失败（158 个报错）。
export default function AppLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">页面加载中</span>
      {/* 标题 + 说明：与 PageHeader 的占位对齐，避免内容到位时跳动 */}
      <div className="space-y-2">
        <div className="h-7 w-40 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded-md bg-muted" />
      </div>
      <div className="h-56 animate-pulse rounded-xl bg-muted" />
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}
