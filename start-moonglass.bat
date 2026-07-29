@echo off
rem ============================================
rem  MoonGlass 启动脚本（开发模式）
rem  双击即可启动芯片开发全流程 AI 工作台
rem  要求：Node >= 22、pnpm >= 10、已执行过 pnpm install
rem ============================================
cd /d %~dp0
title MoonGlass

rem 首次运行或依赖缺失时自动安装
if not exist node_modules (
  echo [MoonGlass] 检测到未安装依赖，正在执行 pnpm install ...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call pnpm install
  if errorlevel 1 (
    echo [MoonGlass] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo [MoonGlass] 正在启动（electron-vite dev）...
call pnpm dev

rem dev 进程退出后暂停，便于查看日志
pause
