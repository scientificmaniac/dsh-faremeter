<#
  dsh-faremeter 打包脚本

  产出两种分发物（都放在 dist\ 下）：

    1. dsh-faremeter-<version>.tgz
       npm 标准包。DSH 的插件安装走的就是它（`dsh plugin install` / 依赖里的 tgz URL），
       内容严格按 package.json 的 files 白名单，**不含测试与打包脚本**。

    2. dsh-faremeter-<version>.zip
       源码分发：解压后就是一个完整插件目录，直接 `pwsh -File install-profile.ps1`
       即可安装（脚本按自身目录定位插件，不依赖当前工作目录）。
       额外带上测试，方便别人复核。

  用法：
    pwsh -File pack.ps1              # 打包并做一次安装产物冒烟
    pwsh -File pack.ps1 -SkipSmoke   # 只打包，不冒烟
#>
[CmdletBinding()]
param(
  [switch]$SkipSmoke
)

$ErrorActionPreference = "Stop"
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $root

function Say($message) { Write-Host "  $message" }
function Step($message) { Write-Host "`n$message" -ForegroundColor Cyan }
function Fail($message) { Write-Host "✗ $message" -ForegroundColor Red; exit 1 }

$manifest = Get-Content (Join-Path $root "package.json") -Raw -Encoding utf8 | ConvertFrom-Json
$name = $manifest.name
$version = $manifest.version
$distDir = Join-Path $root "dist"

Write-Host "`n=== $name $version 打包 ===" -ForegroundColor Green
Say "目录: $root"

# ── 0. 前置检查：必填字段与关键文件 ───────────────────────────────────────────
foreach ($field in @("name", "version", "main")) {
  if (-not $manifest.$field) { Fail "package.json 缺少 $field" }
}
if (-not $manifest.dsh.bundle.patch) { Fail "package.json 缺少 dsh.bundle.patch，DSH 无法把它挂进组合包" }
if (-not $manifest.dsh.client) { Fail "package.json 缺少 dsh.client，客户端界面不会加载" }

$required = @(
  "lib/index.js",
  "lib/client.js",
  "lib/cost-core.mjs",
  "lib/ledger.mjs",
  "lib/session-scan.mjs",
  "cordis.patch.yml",
  "install-profile.ps1",
  "README.md",
  "icon.svg"
)
foreach ($relative in $required) {
  if (-not (Test-Path (Join-Path $root $relative))) { Fail "缺少必需文件：$relative" }
}
Say "必需文件齐全（$($required.Count) 个）"

# ── 1. 测试必须先全绿，否则不该产生分发物 ────────────────────────────────────
Step "① 跑测试"
# 直接逐个跑测试文件（不走 npm 的 shell 包装：本机 pwsh 里 `npm test` 会被解析坏）
$testFiles = @(
  "test/cost-core.test.mjs",
  "test/session-scan.test.mjs",
  "test/client.test.mjs",
  "test/host.test.mjs"
)
$summaries = @()
foreach ($testFile in $testFiles) {
  if (-not (Test-Path (Join-Path $root $testFile))) { Fail "缺少测试文件：$testFile" }
  $output = & node $testFile 2>&1
  $exit = $LASTEXITCODE
  $text = ($output | Out-String)
  if ($exit -ne 0) {
    Write-Host $text
    Fail "$testFile 未通过，已中止打包（修好再打包，别把带病产物发出去）"
  }
  $line = ($text -split "`r?`n" | Where-Object { $_ -match "通过" } | Select-Object -Last 1)
  if (-not $line) { $line = "$testFile OK" }
  $summaries += $line.Trim()
  Say "✓ $testFile"
}
Say ($summaries -join "；")

# ── 2. npm pack ─────────────────────────────────────────────────────────────
Step "② 生成 npm 包（tgz）"
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# npm 默认把日志/缓存写到 %LOCALAPPDATA%\npm-cache，沙箱下可能写不进去；
# 显式把缓存钉在工作区内（也是可复现构建的好处：不污染用户全局缓存）。
$env:npm_config_cache = Join-Path $root ".npm-cache"
$env:npm_config_logs_dir = Join-Path $root ".npm-cache\_logs"
New-Item -ItemType Directory -Force -Path $env:npm_config_logs_dir | Out-Null
$packOutput = & npm.cmd pack --pack-destination $distDir 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host ($packOutput | Out-String)
  Fail "npm pack 失败"
}
$tgzPath = Join-Path $distDir "$name-$version.tgz"
if (-not (Test-Path $tgzPath)) { Fail "没有找到预期产物：$tgzPath" }
Say "已生成: $tgzPath（$([math]::Round((Get-Item $tgzPath).Length / 1KB, 1)) KB）"

# ── 3. 校验 tgz 内容 ────────────────────────────────────────────────────────
Step "③ 校验 tgz 内容"
$listText = (& tar -tzf $tgzPath 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { Fail "无法读取 tgz（tar 不可用？）" }
$entries = ($listText -split "`r?`n") | Where-Object { $_.Trim() -ne "" }
Say "包内条目: $($entries.Count) 个"

$mustContain = @(
  "package/package.json",
  "package/lib/index.js",
  "package/lib/client.js",
  "package/lib/cost-core.mjs",
  "package/lib/ledger.mjs",
  "package/lib/session-scan.mjs",
  "package/cordis.patch.yml",
  "package/install-profile.ps1",
  "package/README.md",
  "package/icon.svg"
)
$missing = @()
foreach ($entry in $mustContain) {
  if (-not ($entries -contains $entry)) { $missing += $entry }
}
if ($missing.Count -gt 0) { Fail "tgz 缺少必需条目：$($missing -join ', ')" }
Say "必需条目齐全"

# 不该出现的：测试、打包脚本、临时产物
$unexpected = $entries | Where-Object { $_ -match "^package/(test/|dist/|pack\.ps1|node_modules/)" }
if ($unexpected) { Fail "tgz 里混进了不该发布的文件：$($unexpected -join ', ')" }
Say "未混入测试/打包脚本/依赖目录"

# ── 4. 解包冒烟：用包里的产物真的加载一次 ───────────────────────────────────
if (-not $SkipSmoke) {
  Step "④ 安装产物冒烟（解包后真跑）"
  $smokeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("$name-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $smokeDir | Out-Null
  try {
    & tar -xzf $tgzPath -C $smokeDir 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "解包失败" }
    $pkgDir = Join-Path $smokeDir "package"

    $smokeScript = @'
import { apply } from "./lib/index.js";

const routes = [];
const cleanups = [];
const logs = [];
let threw = null;
try {
  apply({
    logger: () => ({ info: (m) => logs.push(String(m)) }),
    inject: (deps, cb) => cb({ webServer: { register: (route) => { routes.push(route); return { dispose() {} }; } } }),
    get: () => null,
    effect: (fn) => { const c = fn(); if (typeof c === "function") cleanups.push(c); return () => {}; }
  });
} catch (error) {
  threw = error;
}

const problems = [];
if (threw) problems.push("apply 抛错: " + threw);
if (routes.length !== 1) problems.push(`应注册 1 条路由，实际 ${routes.length}`);
else {
  if (routes[0].path !== "/faremeter/summary") problems.push("路由 path 不对: " + routes[0].path);
  if (routes[0].kind !== "exact") problems.push("路由 kind 不对: " + routes[0].kind);
  if (typeof routes[0].handler !== "function") problems.push("handler 不是函数");
}
if (!logs.some((line) => line.includes("客户端产物"))) problems.push("没有客户端产物审计日志");

// 客户端产物关键标记
import { readFileSync } from "node:fs";
const bundle = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
for (const marker of ["__ModuleLoader__.load", 'id: "dsh-faremeter"', "conversation.chat.assistant-actions", "conversation.composer.dock", "/faremeter/summary"]) {
  if (!bundle.includes(marker)) problems.push("客户端产物缺少标记: " + marker);
}

for (const cleanup of cleanups) { try { cleanup(); } catch {} }

if (problems.length > 0) {
  console.error("SMOKE FAIL: " + problems.join(" | "));
  process.exit(1);
}
console.log("SMOKE OK: 路由已注册、apply 未抛错、客户端产物标记齐全");
'@
    $smokeFile = Join-Path $pkgDir ".smoke.mjs"
    Set-Content -Path $smokeFile -Value $smokeScript -Encoding utf8
    $smokeOutput = & node $smokeFile 2>&1
    $smokeExit = $LASTEXITCODE
    Remove-Item $smokeFile -Force -ErrorAction SilentlyContinue
    Write-Host ($smokeOutput | Out-String).Trim()
    if ($smokeExit -ne 0) { Fail "解包冒烟未通过" }
    Say "解包冒烟通过"
  } finally {
    Remove-Item $smokeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ── 5. 源码 zip（解压即可安装） ─────────────────────────────────────────────
Step "⑤ 生成源码分发包（zip）"
$stageDir = Join-Path $distDir "stage"
$stagePkg = Join-Path $stageDir $name
New-Item -ItemType Directory -Force -Path $stagePkg | Out-Null

# 只复制运行/安装所需 + 测试 + 文档，不复制 dist 自身
$copyItems = @("lib", "docs", "test", "cordis.patch.yml", "install-profile.ps1", "icon.svg", "package.json", "README.md", "pack.ps1")
foreach ($item in $copyItems) {
  $source = Join-Path $root $item
  if (Test-Path $source) {
    Copy-Item $source -Destination $stagePkg -Recurse -Force
  }
}
$zipPath = Join-Path $distDir "$name-$version.zip"
Compress-Archive -Path $stagePkg -DestinationPath $zipPath -CompressionLevel Optimal -Force
Remove-Item $stageDir -Recurse -Force
Say "已生成: $zipPath（$([math]::Round((Get-Item $zipPath).Length / 1KB, 1)) KB）"

# ── 6. 汇总 ─────────────────────────────────────────────────────────────────
Step "⑥ 产物"
Get-ChildItem $distDir -File | ForEach-Object {
  Say ("{0,-34} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB))
}
$sha = (Get-FileHash $tgzPath -Algorithm SHA256).Hash
Say "tgz SHA256: $sha"

Write-Host "`n打包完成 ✅" -ForegroundColor Green
Write-Host @"
  安装 tgz（推荐）：
    把 dist\$name-$version.tgz 放到任意位置，然后在 DSH profile 里：
      npm install "<tgz 绝对路径>"   # 或 dsh plugin 的本地包安装入口
    再把 "$name" 加进 profile 的 dsh.profile.bundles。

  安装 zip（源码方式）：
    解压 dsh-faremeter-$version.zip → 进入 dsh-faremeter 目录 →
      pwsh -File install-profile.ps1
    装完**完全退出并重开** DSH Desktop。

"@ -ForegroundColor Gray
