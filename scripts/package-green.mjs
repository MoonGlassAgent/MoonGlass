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
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

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
const smokeUserData = mkdtempSync(join(tmpdir(), 'moonglass-packaged-smoke-'))
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
- 验证态势改用原子发布的紧凑快照，避免大型 AIGV 状态并发更新导致 JSON 读取失败。
- 04_verification 扩展为三份基线计划与六份 AIGV 方法/闭环文档，覆盖 Intent、风险场景、Formal、Coverage Closure 和 Signoff。
- 一键托管等待 Agent 本轮任务真正完成后才检查门禁和推进阶段，不再提前推进。
- 主会话新增端到端验证闭环：Cocotb + Icarus 功能回归与功能覆盖率，Verilator C++ RTL 覆盖率签核。
- 双通道结果统一合并，生成结构化覆盖率和中文报告，并由独立证据 Review 审查测试、JUnit、日志和覆盖率。
- VERIF 到 QA 门禁增加行覆盖率、条件/表达式覆盖率、功能覆盖率和验证证据要求。
- 项目信息支持后续编辑，总体报告扩展阶段门禁、交付物、验证、覆盖率、综合结果和遗留风险。
- 修复重启后的会话模型显示；文件查看器支持稳定的 Ctrl+F 查找、匹配计数和前后跳转。
- 保留一键托管、受控变更、已有项目阶段恢复、IP 库发现、SRAM 仿真视图与深色模式。

安全说明：
- 未包含 API Key、模型账号配置和 Agent 会话。
- 未包含 .git、仿真编译缓存和 Python 缓存。
`)

// ── 4. 压缩 ────────────────────────────────────────────────
const zipName = `MoonGlass-${VERSION}-Windows-x64-Green-${RELEASE}-MIC_NPU-Demo-${today}.zip`
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
execFileSync('tar.exe', ['-a', '-cf', zipPath, '-C', outRoot, basename(appDir)], { stdio: 'inherit' })

const sizeMB = (statSync(zipPath).size / 1024 / 1024).toFixed(1)
console.log(`[green] 完成：${zipPath}（${sizeMB} MB）`)
