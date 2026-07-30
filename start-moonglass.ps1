# MoonGlass 启动脚本 (PowerShell)
# 右键 -> "使用 PowerShell 运行"

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

Write-Host "`nMoonGlass 芯片开发全流程 AI 工作台" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 pnpm
if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
    Write-Host "[INFO] 未找到 pnpm，正在安装..." -ForegroundColor Yellow
    npm install -g pnpm
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] pnpm 安装失败！请手动运行: npm install -g pnpm" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }
}

# 2. 检查 node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "[INFO] 首次启动，安装依赖..." -ForegroundColor Yellow
    pnpm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] 依赖安装失败！" -ForegroundColor Red
        Write-Host "请尝试：`$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; pnpm install"
        Read-Host "按回车退出"
        exit 1
    }
    Write-Host "[OK] 依赖安装完成" -ForegroundColor Green
}

# 3. 清理旧进程
Write-Host "[INFO] 清理旧进程..." -ForegroundColor Yellow
Get-Process "electron" -ErrorAction SilentlyContinue | Stop-Process -Force
# 清理之前的 electron-vite dev 进程
Get-Process "node" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*MoonGlass*" } | Stop-Process -Force
Start-Sleep -Seconds 1

# 4. 启动
Write-Host "[INFO] 启动 MoonGlass..." -ForegroundColor Green
Write-Host "[INFO] 首次加载约需 10-20 秒" -ForegroundColor Green
Write-Host "[INFO] 关闭软件窗口后，按 Ctrl+C 退出此终端`n" -ForegroundColor Green

pnpm dev

# 5. 异常处理
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] MoonGlass 异常退出（错误码: $LASTEXITCODE）" -ForegroundColor Red
    Read-Host "按回车退出"
}
