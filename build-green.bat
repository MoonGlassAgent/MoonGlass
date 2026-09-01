@echo off
chcp 65001 >nul
rem ============================================================
rem  MoonGlass 绿色版（便携版）打包入口 —— 双击即可打包
rem  本质是调用 Build-Green.ps1 统一管线：
rem    类型检查 -> 核心测试 -> 生产构建 -> 绿色版组装
rem    -> EXE 启动自检 -> ZIP 压缩 -> SHA-256
rem
rem  可选参数（原样透传给 Build-Green.ps1）：
rem    -SkipChecks                跳过类型检查与核心测试（快速打包）
rem    -SkipBuild                 复用 dist/win-unpacked（跳过构建）
rem    -UserData "D:\xx\userdata" 指定演示数据目录
rem  示例：build-green.bat -SkipChecks
rem ============================================================
setlocal
cd /d "%~dp0"

echo.
echo ============================================================
echo   MoonGlass 绿色版打包
echo ============================================================
echo.

rem ---- 基础环境检查 ----
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 node，请先安装 Node.js 并加入 PATH。
    goto :fail
)
where pnpm >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 pnpm，请先运行：npm install -g pnpm
    goto :fail
)

rem ---- 调用统一打包脚本（参数透传）----
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-Green.ps1" %*
if errorlevel 1 (
    echo.
    echo [失败] 打包未成功，请查看上方日志定位问题。
    goto :fail
)

echo.
echo [完成] 绿色版已生成到 green-dist-v* 目录。
goto :end

:fail
echo.
echo 若需跳过检查快速打包，可运行：build-green.bat -SkipChecks
:end
echo.
pause
endlocal
