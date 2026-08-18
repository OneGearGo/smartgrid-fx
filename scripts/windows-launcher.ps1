# 外汇网格总控台 · Windows 一键启动器
# 检查 Node.js 20+ -> 生成 .env（如无）-> 安装依赖 -> 启动服务器并打开浏览器
[CmdletBinding()]
param(
  [switch]$InstallOnly,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-EnvValue([string]$Key) {
  $envFile = Join-Path $ProjectRoot '.env'
  if (-not (Test-Path -LiteralPath $envFile)) { return '' }
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
      $current = $Matches[1].Trim()
      if (($current.StartsWith('"') -and $current.EndsWith('"')) -or ($current.StartsWith("'") -and $current.EndsWith("'"))) {
        return $current.Substring(1, $current.Length - 2)
      }
      return ($current -replace '\s+#.*$', '').Trim()
    }
  }
  return ''
}

function Find-Node {
  # 1) 环境变量指定  2) PATH  3) 项目内 .runtime 便携版
  $candidates = @()
  $envNode = Get-EnvValue 'NODE_PATH'
  if ($envNode) { $candidates += $envNode }
  $candidates += (Get-Command node -ErrorAction SilentlyContinue).Source
  $portable = Join-Path $ProjectRoot '.runtime\node\node.exe'
  if (Test-Path -LiteralPath $portable) { $candidates += $portable }
  foreach ($c in $candidates) {
    if (-not $c -or -not (Test-Path -LiteralPath $c)) { continue }
    try {
      $v = (& $c --version 2>$null | Select-Object -First 1)
      if ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20) { return $c }
    } catch { }
  }
  return $null
}

function Assert-ProjectChild([string]$Target) {
  $full = [IO.Path]::GetFullPath($Target)
  if (-not $full.StartsWith($ProjectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作项目目录外的路径：$full"
  }
  return $full
}

# ── 1. Node.js 检测 ─────────────────────────────────────────────────────────
Write-Step '检查 Node.js 20+'
$node = Find-Node
if (-not $node) {
  Write-Host '[ERROR] 未找到 Node.js 20+。' -ForegroundColor Red
  Write-Host '  请到 https://nodejs.org 安装 Node.js LTS（20 或更高版本）后重试。'
  Write-Host '  或设置 .env 中的 NODE_PATH 指向 node.exe 完整路径。'
  exit 1
}
$nodeVer = & $node --version
Write-Host "  使用 Node.js $nodeVer @ $node"

# ── 2. .env 生成 ────────────────────────────────────────────────────────────
$envFile = Join-Path $ProjectRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
  Write-Step '生成 .env（复制 .env.example，默认全部 paper 模拟盘）'
  Copy-Item -LiteralPath (Join-Path $ProjectRoot '.env.example') -Destination $envFile
  Write-Host '  .env 已生成。五个品种默认全部为 paper，不会发送真实订单。'
} else {
  Write-Host '  .env 已存在，跳过生成。'
}

# 检查是否有实盘槽位（提示）
$liveSlots = @('EUR_MODE','GBP_MODE','JPY_MODE','XAU_MODE','NAS_MODE') | Where-Object {
  (Get-EnvValue $_) -eq 'live'
}
if ($liveSlots.Count -gt 0) {
  Write-Host ''
  Write-Host ("  ⚠ 检测到实盘槽位：" + ($liveSlots -join ', ')) -ForegroundColor Yellow
  Write-Host '    这些槽位将发送真实订单到 MT5 账户！请确认账户与配置无误。' -ForegroundColor Yellow
} else {
  Write-Host '  全部槽位为 paper（模拟盘）。'
}

# ── 3. 依赖安装 ─────────────────────────────────────────────────────────────
Write-Step '检查依赖'
$nodeModules = Join-Path $ProjectRoot 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) {
  Write-Host '  安装依赖（npm ci）...'
  Push-Location $ProjectRoot
  try {
    & $node (Join-Path $ProjectRoot 'node_modules\npm\bin\npm-cli.js') ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败（exit $LASTEXITCODE）" }
  } finally { Pop-Location }
} else {
  Write-Host '  依赖已存在。'
}

if ($InstallOnly) {
  Write-Host ''
  Write-Host '安装完成（InstallOnly）。'
  exit 0
}

# ── 4. 启动 ─────────────────────────────────────────────────────────────────
Write-Step '启动服务器'
$port = Get-EnvValue 'PORT'
if (-not $port) { $port = '8283' }
$listenTest = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
if ($listenTest) {
  Write-Host "[WARN] 端口 $port 已被占用。请在 .env 里改 PORT=8284 后重试。" -ForegroundColor Yellow
  Write-Host "       （原版 WGALL 或另一实例可能正在运行。）" -ForegroundColor Yellow
  exit 1
}

if (-not $NoBrowser) {
  Start-Process "http://127.0.0.1:$port" | Out-Null
}

Push-Location $ProjectRoot
try {
  & $node 'src/server.js'
  exit $LASTEXITCODE
} finally { Pop-Location }
