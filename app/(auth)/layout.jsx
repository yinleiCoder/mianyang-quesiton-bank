// 公开鉴权页外壳：居中卡片 + 品牌区。
// 标题由各页自报（登录/注册），本布局不再写死——否则注册页会顶着「登录」的标签页标题。
export default function AuthLayout({ children }) {
  return (
    <div className="relative flex min-h-svh flex-1 flex-col items-center justify-center bg-muted/40 p-4 md:p-10">
      {/* 背景装饰 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute bottom-0 right-[10%] h-56 w-56 rounded-full bg-sky-500/10 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <img
            src="/mianyang.svg"
            alt=""
            width={40}
            height={40}
            className="size-10 shrink-0 object-contain"
          />
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight">
              绵阳市中职共建题库
            </p>
            <p className="text-xs text-muted-foreground">
              多校共建 · 全市共享
            </p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-6 shadow-sm md:p-8">
          {children}
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          绵阳市教育与体育局 · 职业教育题库建设
        </p>
      </div>
    </div>
  )
}
