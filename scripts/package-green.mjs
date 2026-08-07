/**
 * 绿色版（便携版）打包脚本
 *
 * 流程：
 *   1. 物化 pi 运行时（scripts/stage-pi-runtime.mjs）
 *   2. electron-builder --win dir 生成 dist/win-unpacked
 *   3. 组装 green-dist-rN/MoonGlass/：便携标记 portable-mode + 演示 userdata（MIC_NPU）
 *   4. 生成启动脚本、README，并压缩为 ZIP
 *
 * 用法：
 *   node scripts/package-green.mjs [--skip-build] [--userdata <dir>] [--release <name>]
 *
 * 演示数据源优先级：--userdata 参数 > demo-seed/userdata > 历史 r4 绿色版 userdata。
 * 安全要求：演示数据不得包含 llm-providers.json / API Key / Agent 会话。
 */

import { execFileSync, execSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = process.cwd()
const args = process.argv.slice(2)
const hasFlag = (f) => args.includes(f)
const optValue = (name) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : null
}

const RELEASE = optValue('--release') ?? 'r5'
const SKIP_BUILD = hasFlag('--skip-build')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
const VERSION = pkg.version
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '')

const R4_USERDATA = 'D:/Projects/ASIC_Flow/MoonGlass/green-dist-r4-release2/win-unpacked/userdata'
const seedCandidates = [
  optValue('--userdata'),
  join(ROOT, 'demo-seed', 'userdata'),
  existsSync(join(R4_USERDATA, 'moonglass')) ? R4_USERDATA : null
].filter(Boolean)

const seedDir = seedCandidates.find((d) => existsSync(join(d, 'moonglass', 'projects.json')))
const outRoot = join(ROOT, `green-dist-${RELEASE}`)
const appDir = join(outRoot, 'MoonGlass')
const unpacked = join(ROOT, 'dist', 'win-unpacked')

console.log(`[green] MoonGlass v${VERSION} 绿色版 ${RELEASE}`)

// ── 1. 构建 ────────────────────────────────────────────────
if (!SKIP_BUILD) {
  console.log('[green] 步骤 1/2：物化 pi 运行时 + electron-builder --win dir ...')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'stage-pi-runtime.mjs')], { stdio: 'inherit' })
  execSync('pnpm build', { cwd: ROOT, stdio: 'inherit' })
  execSync('pnpm exec electron-builder --win dir', { cwd: ROOT, stdio: 'inherit' })
} else {
  console.log('[green] --skip-build：复用 dist/win-unpacked')
}

// ── 2. 健全性检查：pi 运行时依赖必须随包分发 ────────────────
const packagedPi = join(unpacked, 'resources', 'pi-coding-agent')
if (!existsSync(join(packagedPi, 'node_modules', 'undici', 'package.json'))) {
  console.error('[green] 打包产物缺少 pi 运行时依赖（resources/pi-coding-agent/node_modules）。')
  console.error('        请确认 electron-builder.yml 的 extraResources 指向 build-resources/pi-runtime。')
  process.exit(1)
}
const piVersion = execFileSync(
  process.execPath, [join(packagedPi, 'dist', 'cli.js'), '--version'], { encoding: 'utf-8' }
).trim()
console.log(`[green] 打包内 pi 运行时自检通过（pi v${piVersion}）`)

// ── 3. 组装绿色目录 ─────────────────────────────────────────
rmSync(outRoot, { recursive: true, force: true })
mkdirSync(appDir, { recursive: true })
console.log('[green] 复制 win-unpacked ...')
cpSync(unpacked, appDir, { recursive: true })

// 便携模式标记（src/main/index.ts 检测后把 userData 重定向到程序目录 userdata/）
writeFileSync(join(appDir, 'portable-mode'), 'portable\n')

// 演示数据（MIC_NPU）
if (seedDir) {
  // 安全检查：禁止把密钥/会话带进演示包
  for (const forbidden of ['llm-providers.json', 'agent-model-selections.json']) {
    const hit = join(seedDir, 'moonglass', forbidden)
    if (existsSync(hit)) {
      console.error(`[green] 演示数据包含 ${forbidden}，可能泄露模型配置/密钥，已中止。`)
      process.exit(1)
    }
  }
  console.log(`[green] 注入演示数据：${seedDir}`)
  cpSync(seedDir, join(appDir, 'userdata'), { recursive: true })
  const projects = JSON.parse(readFileSync(join(seedDir, 'moonglass', 'projects.json'), 'utf-8'))
  console.log(`[green] 内置项目：${projects.projects.map((p) => p.name).join(', ')}`)
} else {
  console.warn('[green] 未找到演示 userdata，将生成空白绿色版（可用 --userdata 指定）')
}

writeFileSync(join(appDir, 'Start-MoonGlass.bat'),
  '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nstart "" "%~dp0MoonGlass.exe"\r\nendlocal\r\n')

writeFileSync(join(appDir, 'README-ZH-CN.txt'), `MoonGlass ASIC Design Agent 绿色版 ${RELEASE}（v${VERSION}）

使用方法：
1. 完整解压 ZIP 后，双击 MoonGlass.exe 或 Start-MoonGlass.bat。
2. 数据保存在程序目录内的 userdata，不写入系统默认 MoonGlass 数据目录。
3. 已内置 MIC_NPU Demo，首次启动自动建立数据库并显示在项目列表中。
4. 首次使用请在「设置」中配置模型服务（API Key 不随包分发）。

${RELEASE} 修复：
- 修复绿色版无法选择模型 / 对话无法启动的问题：
  此前安装包只携带 pi-coding-agent 本体而缺失其全部运行依赖，
  Agent 子进程（pi --mode rpc）启动即崩溃，报
  “[pi-rpc] 等待就绪超时：[pi-rpc] 进程未启动”。
  现在 pi 运行时及其 128 个依赖包由 scripts/stage-pi-runtime.mjs
  完整物化后随包分发，并通过打包内自检。

安全说明：
- 未包含 API Key、模型账号配置和 Agent 会话。
- 未包含 .git、仿真编译缓存和 Python 缓存。
`)

// ── 4. 压缩 ────────────────────────────────────────────────
const zipName = `MoonGlass-${VERSION}-Windows-x64-Green-${RELEASE}-MIC_NPU-Demo-${today}.zip`
const zipPath = join(outRoot, zipName)
console.log('[green] 压缩 ZIP ...')
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${appDir}' -DestinationPath '${zipPath}' -Force"`,
  { stdio: 'inherit' }
)

const sizeMB = (statSync(zipPath).size / 1024 / 1024).toFixed(1)
console.log(`[green] 完成：${zipPath}（${sizeMB} MB）`)
