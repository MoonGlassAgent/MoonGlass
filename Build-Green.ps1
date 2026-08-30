<#
.SYNOPSIS
打包 MoonGlass Windows 绿色版的统一入口。

.DESCRIPTION
自动读取 package.json 版本号，执行类型检查、核心测试、生产构建、绿色版组装、
真实 EXE 启动自检、文件数量检查和 ZIP 压缩，最后输出 SHA-256。
脚本不会关闭或重启当前正在运行的 MoonGlass。

.EXAMPLE
.\Build-Green.ps1

.EXAMPLE
.\Build-Green.ps1 -UserData "D:\Demo\userdata"

.EXAMPLE
.\Build-Green.ps1 -SkipChecks
#>

[CmdletBinding()]
param(
    [string]$UserData,
    [switch]$SkipChecks,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$PackageJson = Join-Path $Root 'package.json'
$LockFile = Join-Path $Root '.green-package.lock'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "命令执行失败（exit=$LASTEXITCODE）：$Command $($Arguments -join ' ')"
    }
}

if (-not (Test-Path -LiteralPath $PackageJson)) {
    throw "未找到 package.json：$PackageJson"
}
if (Test-Path -LiteralPath $LockFile) {
    throw "检测到另一个绿色版打包任务正在运行。如果上次任务异常退出，请删除：$LockFile"
}

$Package = Get-Content -LiteralPath $PackageJson -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = [string]$Package.version
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw 'package.json 中没有有效版本号。'
}

$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$Release = "v$Version"
$OutputDirectory = Join-Path $Root "green-dist-$Release"
$StartedAt = Get-Date

Set-Content -LiteralPath $LockFile -Value "PID=$PID`nStartedAt=$($StartedAt.ToString('o'))" -Encoding ascii

try {
    Push-Location $Root
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host " MoonGlass v$Version Windows 绿色版打包" -ForegroundColor Cyan
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host "项目目录：$Root"
    Write-Host "输出目录：$OutputDirectory"
    Write-Host '当前运行中的 MoonGlass 不会被关闭。'

    if (-not $SkipChecks) {
        Write-Host "`n[1/3] 类型检查" -ForegroundColor Yellow
        Invoke-Checked $Pnpm 'typecheck'

        Write-Host "`n[2/3] 核心测试" -ForegroundColor Yellow
        Invoke-Checked $Pnpm 'test'
    }
    else {
        Write-Warning '已跳过类型检查和核心测试。'
    }

    Write-Host "`n[3/3] 构建并组装绿色版" -ForegroundColor Yellow
    $PackageArguments = @((Join-Path $Root 'scripts\package-green.mjs'), '--release', $Release)
    if ($SkipBuild) { $PackageArguments += '--skip-build' }
    if (-not [string]::IsNullOrWhiteSpace($UserData)) {
        $ResolvedUserData = (Resolve-Path -LiteralPath $UserData -ErrorAction Stop).Path
        $PackageArguments += @('--userdata', $ResolvedUserData)
    }
    Invoke-Checked $Node @PackageArguments

    $Zip = Get-ChildItem -LiteralPath $OutputDirectory -Filter "MoonGlass-$Version-Windows-x64-Green-$Release-*.zip" -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $Zip) {
        throw "打包命令结束，但未找到预期 ZIP：$OutputDirectory"
    }

    $Hash = Get-FileHash -LiteralPath $Zip.FullName -Algorithm SHA256
    $FileCount = (Get-ChildItem -LiteralPath (Join-Path $OutputDirectory 'MoonGlass') -File -Recurse).Count
    $Elapsed = (Get-Date) - $StartedAt

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host ' 绿色版打包成功' -ForegroundColor Green
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host "版本：v$Version"
    Write-Host "ZIP：$($Zip.FullName)"
    Write-Host ('大小：{0:N1} MB' -f ($Zip.Length / 1MB))
    Write-Host "文件数量：$FileCount"
    Write-Host "SHA-256：$($Hash.Hash)"
    Write-Host ('耗时：{0:hh\:mm\:ss}' -f $Elapsed)
}
catch {
    Write-Host "`n绿色版打包失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '请保留本窗口输出用于定位问题。' -ForegroundColor Red
    exit 1
}
finally {
    Pop-Location
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
