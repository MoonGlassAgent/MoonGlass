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
 * 演示数据源优先级：--userdata 参数 > demo-seed/userdata > 最近一次绿色版产物 userdata。
 * 安全要求：演示数据不得包含 llm-providers.json / API Key / Agent 会话。
 */

import { execFileSync, execSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
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

const SKIP_BUILD = hasFlag('--skip-build')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
const RELEASE = optValue('--release') ?? `v${pkg.version}`
const VERSION = pkg.version
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '')

const outRoot = join(ROOT, `green-dist-${RELEASE}`)
const appDir = join(outRoot, 'MoonGlass')
const unpacked = join(ROOT, 'dist', 'win-unpacked')

// 演示数据（MIC_NPU）种子来源，按优先级：
//   1. --userdata <dir>：显式指定
//   2. demo-seed/userdata：仓库内的固定演示数据目录（若存在）
//   3. 最近一次绿色版产物中的 userdata：自动延续上一版演示数据
function discoverLatestGreenUserdata() {
  const candidates = []
  for (const entry of readdirSync(ROOT)) {
    if (!entry.startsWith('green-dist-')) continue
    const distDir = join(ROOT, entry)
    if (distDir === outRoot) continue // 排除本次输出目录，避免拾取残留/半成品
    const dir = join(distDir, 'MoonGlass', 'userdata')
    if (existsSync(join(dir, 'moonglass', 'projects.json'))) candidates.push(dir)
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return candidates[0] ?? null
}

const seedCandidates = [
  optValue('--userdata'),
  join(ROOT, 'demo-seed', 'userdata'),
  discoverLatestGreenUserdata()
].filter(Boolean)

const seedDir = seedCandidates.find((d) => existsSync(join(d, 'moonglass', 'projects.json')))

console.log(`[green] MoonGlass v${VERSION} 绿色版 ${RELEASE}`)

// ── 1. 构建 ────────────────────────────────────────────────
if (!SKIP_BUILD) {
  console.log('[green] 步骤 1/2：物化 pi 运行时与内置 AIGV 工具链 + electron-builder --win dir ...')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'stage-pi-runtime.mjs')], { stdio: 'inherit' })
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'stage-aigv-runtime.mjs')], { stdio: 'inherit' })
  execSync('pnpm build', { cwd: ROOT, stdio: 'inherit' })
  const mainBundle = readFileSync(join(ROOT, 'out', 'main', 'index.js'), 'utf-8')
  const externalWorkspaceRequires = [...mainBundle.matchAll(/require\(["'](@moonglass\/[^"']+)["']\)/g)].map((match) => match[1])
  if (externalWorkspaceRequires.length) {
    console.error(`[green] 主进程仍外置 TypeScript workspace 包：${[...new Set(externalWorkspaceRequires)].join(', ')}`)
    console.error('        这些包必须加入 electron-vite externalizeDepsPlugin.exclude。')
    process.exit(1)
  }
  console.log('[green] 主进程 workspace bundle 检查通过')
  execSync('pnpm exec electron-builder --win dir', { cwd: ROOT, stdio: 'inherit' })
} else {
  console.log('[green] --skip-build：复用 dist/win-unpacked')
}

// ── 2. 健全性检查：pi 运行时依赖必须随包分发 ────────────────
const packagedPi = join(unpacked, 'resources', 'pi-runtime.asar')
if (!existsSync(packagedPi)) {
  console.error('[green] 打包产物缺少 pi 运行时归档（resources/pi-runtime.asar）。')
  console.error('        请确认 afterPack 已执行。')
  process.exit(1)
}
const piVersion = execFileSync(
  join(unpacked, 'MoonGlass.exe'), [`${packagedPi}/dist/cli.js`, '--version'],
  { encoding: 'utf-8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
).trim()
console.log(`[green] 打包内 pi 运行时自检通过（pi v${piVersion}）`)
const packagedAigv = join(unpacked, 'resources', 'bundled-toolchains', 'windows-x64', 'moonglass-aigv-runtime.tgz')
if (!existsSync(packagedAigv)) {
  console.error('[green] 打包产物缺少内置 AIGV 工具链归档。')
  process.exit(1)
}
console.log(`[green] 内置 AIGV 工具链归档就绪（${(statSync(packagedAigv).size / 1024 / 1024).toFixed(1)} MB）`)

// 真实启动打包后的主进程，捕获 app.asar、native module 和服务初始化错误。
const smokeRoot = join(ROOT, 'dist', '.smoke')
mkdirSync(smokeRoot, { recursive: true })
const smokeUserData = mkdtempSync(join(smokeRoot, 'moonglass-packaged-smoke-'))
try {
  const smokeOutput = execFileSync(
    join(unpacked, 'MoonGlass.exe'), [`--user-data-dir=${smokeUserData}`],
    { encoding: 'utf-8', timeout: 30_000, windowsHide: true, env: { ...process.env, MOONGLASS_STARTUP_SMOKE: '1' } }
  )
  if (!smokeOutput.includes('[moonglass] packaged startup smoke passed')) {
    console.error('[green] 打包 EXE 未返回主进程启动成功标记。')
    process.exit(1)
  }
  console.log('[green] 打包 EXE 主进程真实启动自检通过')
} finally {
  rmSync(smokeUserData, { recursive: true, force: true })
}

// ── 3. 组装绿色目录 ─────────────────────────────────────────
rmSync(outRoot, { recursive: true, force: true })
mkdirSync(appDir, { recursive: true })
console.log('[green] 复制 win-unpacked ...')
cpSync(unpacked, appDir, { recursive: true })

// 法律与使用文档放在绿色版根目录，用户无需解包 app.asar 即可阅读。
for (const file of [
  'LICENSE', 'NOTICE', 'LICENSE-CHANGE.md', 'COMMERCIAL-LICENSE.md',
  'THIRD-PARTY-NOTICES.md', 'PRIVACY.md', 'TRADEMARKS.md', 'SECURITY.md'
]) {
  cpSync(join(ROOT, file), join(appDir, file))
}
mkdirSync(join(appDir, 'docs'), { recursive: true })
cpSync(join(ROOT, 'docs', 'USER-MANUAL-ZH-CN.md'), join(appDir, 'docs', 'USER-MANUAL-ZH-CN.md'))

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

授权说明：
- MoonGlass 为 Source Available 软件，不是 OSI 定义的 Open Source 软件。
- 非商业使用遵循 PolyForm Noncommercial License 1.0.0。
- 企业研发、客户交付、收费服务、流片或量产等商业用途须另行取得书面授权。
- 详细条款见程序目录 LICENSE、NOTICE 和 COMMERCIAL-LICENSE.md。
- 商务联系：moonglassagent@126.com

v${VERSION} 主要更新：
- AIGV 波段化验证流程：W0 冒烟 → W1 基础功能 → W2 增补主题波 → W3 签核，
  验证操作按钮与验证态势页波段进度一一对应；完备性看规格映射矩阵，不再看风险队列深度。
- 规格映射完备性：断言级规格条款 → 验证意图 → 测试证据的闭集映射；
  未映射条款显式告警；PPA（面积/功耗/时序）条款归综合阶段验收，不再混入验证分母。
- 证据管线：仿真/综合/Formal 工具自动登记场景证据并自动重建验证态势，
  场景裁决权限收敛（执行状态只能由证据派生，豁免需具名审批）。
- LLM 主导验证规划：Agent 读规格圈定真实验证点并锚定风险/条款/信号登记，
  引擎负责候选兜底、锚点校验与证据记账。
- 任务粒度会话：新任务会话零历史继承、artifact 索引自举；VERIF 批次由主进程
  编排到独立会话执行，完成判定绑定工具证据；批次会话只读窥视、停止全覆盖。
- RTL 修复闭环：根因确认后派发独立修复会话，修复窗口内 RTL 写保护与派发门控，
  事后审计快照供签核审查。
- 阶段切换不再中断正在运行的 Agent（后台续跑 + 完成通知）；
  VERIF 上下文治理（摘要入口、大文件禁读、按阶段自动压缩阈值）。

安全说明：
- 未包含 API Key、模型账号配置和 Agent 会话。
- 未包含 .git、仿真编译缓存和 Python 缓存。
`)

// ── 4. 压缩 ────────────────────────────────────────────────
// ZIP 命名：MoonGlass-<版本>-Windows-x64-Green-v<版本>-<yyyymmdd>.zip
const zipName = `MoonGlass-${VERSION}-Windows-x64-Green-${RELEASE}-${today}.zip`
const zipPath = join(outRoot, zipName)
const fileCount = readdirSync(appDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).length
if (fileCount > 1200) {
  console.error(`[green] 文件数量异常：${fileCount}（上限 1200），已中止打包。`)
  console.error('        请检查是否把展开的 node_modules 或缓存带入绿色版。')
  process.exit(1)
}
console.log(`[green] 文件数量检查通过：${fileCount}`)
console.log('[green] 压缩 ZIP ...')
// Windows 上用系统自带 bsdtar：GNU tar（Git Bash 环境 PATH 优先）会把 "D:" 盘符当作远程主机语法而失败
// （与 scripts/stage-aigv-runtime.mjs 同一规避口径）
const tarExe = process.platform === 'win32' && existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'))
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'
execFileSync(tarExe, ['-a', '-cf', zipPath, '-C', outRoot, basename(appDir)], { stdio: 'inherit' })

const sizeMB = (statSync(zipPath).size / 1024 / 1024).toFixed(1)
console.log(`[green] 完成：${zipPath}（${sizeMB} MB）`)
