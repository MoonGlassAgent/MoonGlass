@echo off
chcp 65001 >nul
title MoonGlass v0.3

echo 🌙 MoonGlass 芯片开发全流程 AI 工作台
echo ======================================
echo.

cd /d "%~dp0"

:: 如果没装 pnpm，引导安装
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] 未找到 pnpm，尝试 npm install -g pnpm...
    call npm install -g pnpm
)

:: 检查 node_modules
if not exist "node_modules" (
    echo [INFO] 首次启动，安装依赖…
    call pnpm install
    if %errorlevel% neq 0 (
        echo [ERROR] 依赖安装失败，请尝试手动运行：
        echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
        echo   pnpm install
        pause
        exit /b 1
    )
)

echo [INFO] 启动 MoonGlass...
pnpm dev
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] MoonGlass 异常退出
    pause
)
