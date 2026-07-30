@echo off
chcp 65001 >nul
title MoonGlass v0.3
cd /d "%~dp0"

echo.
echo MoonGlass 芯片开发全流程 AI 工作台
echo ===================================
echo.

:: 1. 检查 pnpm
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] 未找到 pnpm，正在安装...
    call npm install -g pnpm
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] pnpm 安装失败！请手动运行：npm install -g pnpm
        pause
        exit /b 1
    )
)

:: 2. 检查 node_modules
if not exist "node_modules" (
    echo [INFO] 首次启动，安装依赖（可能需要几分钟）...
    echo.
    call pnpm install --config.confirmModulesPurge=false
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] 依赖安装失败！
        echo 请尝试手动运行：
        echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
        echo   pnpm install --config.confirmModulesPurge=false
        pause
        exit /b 1
    )
    echo [OK] 依赖安装完成
) else (
    :: node_modules 已存在，但可能 lock 有变更
    call pnpm install --config.confirmModulesPurge=false --no-frozen-lockfile 2>nul
)

:: 3. 清理旧进程（避免端口冲突）
echo [INFO] 清理旧进程...
taskkill /f /im electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul

:: 4. 启动
echo [INFO] 启动 MoonGlass v0.3 ...
echo [INFO] 首次加载约需 10-20 秒
echo [INFO] 关闭软件窗口后，按 Ctrl+C 退出此终端
echo.
pnpm dev

:: 5. 异常处理
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] MoonGlass 异常退出（错误码：%errorlevel%）
    pause
)
