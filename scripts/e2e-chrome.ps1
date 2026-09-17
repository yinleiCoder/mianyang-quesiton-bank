# 启动一个带调试端口的独立 Chrome 实例，供 scripts/e2e-cdp.mjs 驱动。
#
# 用独立的 --user-data-dir：直接挂到默认配置上会与用户正在用的 Chrome 抢单例锁，
# 结果是"命令发出去了但新实例立刻退出"，而且不报错。
# 无头与否由 -Headless 决定：调试选择器/看布局时用有头，回归跑批用无头。
param(
  [switch]$Headless,
  [int]$Port = 9222
)

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { throw "找不到 Chrome / Edge，请手动指定浏览器路径" }

$profile = Join-Path $env:TEMP "mianyang-e2e-chrome"
$args = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$profile",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1440,1000",
  "about:blank"
)
if ($Headless) { $args = @("--headless=new") + $args }

Write-Host "启动：$chrome"
Start-Process -FilePath $chrome -ArgumentList $args
Start-Sleep -Seconds 3

try {
  $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version"
  Write-Host "调试端口就绪：$($v.Browser)"
} catch {
  throw "调试端口未就绪，Chrome 可能启动失败"
}
