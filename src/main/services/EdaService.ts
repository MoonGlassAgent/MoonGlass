/**
 * EDA 工具服务
 *
 * 对 @moonglass/eda-bridge 的服务化封装。
 * 提供工具探测、缺失工具一键安装（OSS CAD Suite / Verible / Cocotb）、
 * 系统 PATH 刷新与 GTKWave 波形打开能力。
 */

import { spawn } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { computeMissingInstallPlan, detectToolchain, locateTool, mergePathEntries } from '@moonglass/eda-bridge'
import type { InstallMissingSummary, ToolDetection, ToolInstallJob, ToolInstallResult, WaveformOpenResult } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'
import type { ProjectService } from './ProjectService'

// Windows 上优先用系统自带 bsdtar：GNU tar（Git Bash 环境 PATH 优先）会把
// "D:" 盘符当作远程主机语法而失败（Cannot connect to D: resolve failed）。
// 与 scripts/stage-aigv-runtime.mjs 同一规避口径。
const TAR_EXE = process.platform === 'win32' && existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'))
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'

export class EdaService implements MoonGlassService {
  readonly name = 'eda-service'
  private readonly toolchainRoot: string
  private readonly bundledAigvRoot: string
  private readonly detectionCachePath: string
  private detectionCache: ToolDetection[] | null = null
  private readonly installJobs = new Map<string, ToolInstallJob>()
  private static readonly REQUEST_TIMEOUT_MS = 30_000
  private static readonly DOWNLOAD_TIMEOUT_MS = 30 * 60_000
  /** 一键安装缺失工具的编排任务固定 id（复用 installJobs 轮询） */
  static readonly INSTALL_MISSING_JOB_ID = 'install-missing'

  constructor(userDataDir: string, private readonly projects: ProjectService) {
    this.toolchainRoot = join(userDataDir, 'moonglass', 'toolchains')
    this.bundledAigvRoot = join(this.toolchainRoot, 'bundled-aigv', 'aigv-toolchain')
    this.detectionCachePath = join(userDataDir, 'moonglass', 'eda-detection-cache.json')
  }

  async start(): Promise<void> {
    await mkdir(this.toolchainRoot, { recursive: true })
    try { await this.ensureBundledAigvRuntime() } catch (error) { console.error('[eda-service] 内置 AIGV 工具链部署失败', error) }
    this.activateToolchains()
    this.loadDetectionCache()
  }

  stop(): void {
    // 无常驻资源
  }

  async detectTools(force = false): Promise<ToolDetection[]> {
    if (!force && this.detectionCache) return this.detectionCache
    // 强制重检前先从注册表合并最新系统 PATH：外部安装器修改的 PATH
    // 对运行中的 Electron 进程不可见，不刷新就只能重启生效。
    if (force) await this.refreshSystemPath()
    this.activateToolchains()
    const tools = (await detectToolchain()).map((tool) => ({ ...tool, source: this.toolSource(tool.path) }))
    this.detectionCache = tools
    this.persistDetectionCache(tools)
    return tools
  }

  private loadDetectionCache(): void {
    if (!existsSync(this.detectionCachePath)) return
    try {
      const cached = JSON.parse(readFileSync(this.detectionCachePath, 'utf-8')) as {
        version?: number
        platform?: string
        arch?: string
        tools?: ToolDetection[]
      }
      if (cached.version === 2 && cached.platform === process.platform && cached.arch === process.arch && Array.isArray(cached.tools)) {
        this.detectionCache = cached.tools
      }
    } catch (error) {
      console.warn('[eda-service] EDA 检测缓存读取失败，将重新检测', error)
    }
  }

  private persistDetectionCache(tools: ToolDetection[]): void {
    try {
      mkdirSync(dirname(this.detectionCachePath), { recursive: true })
      writeFileSync(this.detectionCachePath, JSON.stringify({
        version: 2,
        platform: process.platform,
        arch: process.arch,
        detectedAt: new Date().toISOString(),
        tools
      }, null, 2), 'utf-8')
    } catch (error) {
      console.warn('[eda-service] EDA 检测缓存保存失败', error)
    }
  }

  /**
   * 刷新系统 PATH（仅 Windows）：读取注册表 Machine + User PATH 与当前进程
   * PATH 合并去重。外部安装器写入的注册表 PATH 对运行中进程不可见，
   * 合并后重新检测即可生效，无需重启。自管 toolchain 目录由随后的
   * activateToolchains() 重新前置。读取失败仅告警，不影响检测。
   */
  private async refreshSystemPath(): Promise<void> {
    if (process.platform !== 'win32') return
    try {
      const output = await this.runProcess('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "$m = [Environment]::GetEnvironmentVariable('Path','Machine'); $u = [Environment]::GetEnvironmentVariable('Path','User'); [Console]::Out.Write($m + [char]0 + $u)"
      ], true)
      const [machine = '', user = ''] = output.split('')
      process.env.PATH = mergePathEntries(process.env.PATH ?? '', [machine, user].filter(Boolean).join(delimiter))
    } catch (error) {
      console.warn('[eda-service] 注册表 PATH 刷新失败，沿用当前进程 PATH', error)
    }
  }

  private static installBundleStartMessage(id: string): string {
    if (id === 'python-cocotb') return '正在通过 pip 安装 Cocotb…'
    if (id === 'verible') return '正在查询 Verible 下载地址…'
    return '正在查询 OSS CAD Suite 下载地址…'
  }

  startInstallBundle(id: string): ToolInstallJob {
    const current = this.installJobs.get(id)
    if (current?.status === 'running') return current
    const job: ToolInstallJob = {
      id,
      status: 'running',
      message: EdaService.installBundleStartMessage(id),
      startedAt: new Date().toISOString()
    }
    this.installJobs.set(id, job)
    void this.installBundle(id).then((result) => {
      this.installJobs.set(id, {
        id,
        status: result.ok ? 'completed' : 'failed',
        message: result.message,
        path: result.path,
        startedAt: job.startedAt,
        finishedAt: new Date().toISOString()
      })
    }).catch((error) => {
      this.installJobs.set(id, {
        id,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        startedAt: job.startedAt,
        finishedAt: new Date().toISOString()
      })
    })
    return job
  }

  getInstallStatus(id: string): ToolInstallJob {
    return this.installJobs.get(id) ?? { id, status: 'idle', message: '尚未开始安装' }
  }

  /** bundle id → 展示名（用于一键安装的进度与结果文案） */
  private static bundleLabel(id: string): string {
    if (id === 'python-cocotb') return 'Cocotb'
    if (id === 'verible') return 'Verible'
    return 'OSS CAD Suite'
  }

  /**
   * 一键安装缺失工具：强制重检后按纯函数计算安装计划，
   * 串行安装缺失 bundle（每个完成后刷新检测），最终返回汇总。
   * runtime/build 中无法自动安装的项与 physical 类别不自动安装，
   * 前者进 manualGuidance 由 UI 展示手动指引，后者不支持。
   */
  startInstallMissing(): ToolInstallJob {
    const id = EdaService.INSTALL_MISSING_JOB_ID
    const current = this.installJobs.get(id)
    if (current?.status === 'running') return current
    const job: ToolInstallJob = {
      id,
      status: 'running',
      message: '正在检测缺失的工具…',
      startedAt: new Date().toISOString()
    }
    this.installJobs.set(id, job)
    void this.installMissing().then((summary) => {
      this.installJobs.set(id, {
        id,
        status: 'completed',
        message: summary.failed.length > 0
          ? `一键安装完成：成功 ${summary.installed.length} 项，失败 ${summary.failed.length} 项，${summary.manualGuidance.length} 项需手动安装`
          : `一键安装完成：成功 ${summary.installed.length} 项，${summary.manualGuidance.length} 项需手动安装`,
        summary,
        startedAt: job.startedAt,
        finishedAt: new Date().toISOString()
      })
    }).catch((error) => {
      this.installJobs.set(id, {
        id,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        startedAt: job.startedAt,
        finishedAt: new Date().toISOString()
      })
    })
    return job
  }

  private async installMissing(): Promise<InstallMissingSummary> {
    const id = EdaService.INSTALL_MISSING_JOB_ID
    const tools = await this.detectTools(true)
    const plan = computeMissingInstallPlan(tools)
    const installed: string[] = []
    const failed: Array<{ id: string; message: string }> = []
    for (const bundle of plan.bundles) {
      const label = EdaService.bundleLabel(bundle)
      this.updateInstallMessage(id, `正在安装 ${label}…`)
      const result = await this.installBundle(bundle, (message) => this.updateInstallMessage(id, message))
      if (result.ok) {
        installed.push(label)
        await this.detectTools(true)
      } else {
        failed.push({ id: label, message: result.message })
      }
    }
    return { installed, failed, manualGuidance: plan.manualGuidance }
  }

  private updateInstallMessage(id: string, message: string): void {
    const current = this.installJobs.get(id)
    if (current?.status === 'running') this.installJobs.set(id, { ...current, message })
  }

  /** 进度上报：既更新 bundle 自身任务消息，也透传给一键安装编排任务 */
  private reportInstallProgress(id: string, message: string, onProgress?: (message: string) => void): void {
    this.updateInstallMessage(id, message)
    onProgress?.(message)
  }

  private async installBundle(id: string, onProgress?: (message: string) => void): Promise<ToolInstallResult> {
    if (id === 'python-cocotb') return this.installCocotb(onProgress)
    if (id === 'verible') return this.installVerible(onProgress)
    if (id !== 'oss-cad-suite') return { ok: false, message: `未知工具包: ${id}` }
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      return { ok: false, message: '当前一键安装暂时仅支持 Windows x64' }
    }

    const suiteDir = join(this.toolchainRoot, 'oss-cad-suite')
    const archivePath = join(this.toolchainRoot, 'oss-cad-suite-windows-x64.tgz')
    try {
      const releaseResponse = await fetch('https://api.github.com/repos/YosysHQ/oss-cad-suite-build/releases/latest', {
        headers: { 'User-Agent': 'MoonGlass' },
        signal: AbortSignal.timeout(EdaService.REQUEST_TIMEOUT_MS)
      })
      if (!releaseResponse.ok) throw new Error(`GitHub Release 查询失败: HTTP ${releaseResponse.status}`)
      const release = await releaseResponse.json() as { assets?: Array<{ name: string; browser_download_url: string }> }
      const asset = release.assets?.find((item) => /^oss-cad-suite-windows-x64-.*\.tgz$/i.test(item.name))
      if (!asset) throw new Error('最新 Release 中没有 Windows x64 工具包')

      await rm(suiteDir, { recursive: true, force: true })
      this.reportInstallProgress(id, '正在下载 OSS CAD Suite，请保持网络连接…', onProgress)
      const download = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': 'MoonGlass' },
        signal: AbortSignal.timeout(EdaService.DOWNLOAD_TIMEOUT_MS)
      })
      if (!download.ok || !download.body) throw new Error(`工具包下载失败: HTTP ${download.status}`)
      await pipeline(Readable.fromWeb(download.body as never), createWriteStream(archivePath))
      this.reportInstallProgress(id, '下载完成，正在后台解压工具包…', onProgress)
      await this.runProcess(TAR_EXE, ['-xzf', archivePath, '-C', this.toolchainRoot])
      await rm(archivePath, { force: true })
      if (!existsSync(join(suiteDir, 'bin'))) throw new Error('工具包解压完成，但未找到 bin 目录')
      this.activateToolchains()
      return { ok: true, message: 'OSS CAD Suite 安装完成', path: suiteDir }
    } catch (error) {
      await rm(archivePath, { force: true }).catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: /abort|timeout/i.test(message) ? '工具包下载超时，请检查网络或代理后重试' : message }
    }
  }

  /**
   * 安装 Verible：GitHub Release 的 windows-amd64 zip，用系统 bsdtar 解压
   * （libarchive 直接支持 zip）。zip 内为 verible-v*-windows-amd64/bin 结构，
   * 解压到 toolchains/verible/ 下，实际 bin 所在目录由 veribleToolchainDir 发现。
   */
  private async installVerible(onProgress?: (message: string) => void): Promise<ToolInstallResult> {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      return { ok: false, message: '当前一键安装暂时仅支持 Windows x64' }
    }
    const veribleDir = join(this.toolchainRoot, 'verible')
    const archivePath = join(this.toolchainRoot, 'verible-windows-amd64.zip')
    try {
      const releaseResponse = await fetch('https://api.github.com/repos/chipsalliance/verible/releases/latest', {
        headers: { 'User-Agent': 'MoonGlass' },
        signal: AbortSignal.timeout(EdaService.REQUEST_TIMEOUT_MS)
      })
      if (!releaseResponse.ok) throw new Error(`GitHub Release 查询失败: HTTP ${releaseResponse.status}`)
      const release = await releaseResponse.json() as { assets?: Array<{ name: string; browser_download_url: string }> }
      const asset = release.assets?.find((item) => /^verible-v.*-windows-amd64\.zip$/i.test(item.name))
      if (!asset) throw new Error('最新 Release 中没有 Windows x64 工具包')

      await rm(veribleDir, { recursive: true, force: true })
      await mkdir(veribleDir, { recursive: true })
      this.reportInstallProgress('verible', '正在下载 Verible，请保持网络连接…', onProgress)
      const download = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': 'MoonGlass' },
        signal: AbortSignal.timeout(EdaService.DOWNLOAD_TIMEOUT_MS)
      })
      if (!download.ok || !download.body) throw new Error(`工具包下载失败: HTTP ${download.status}`)
      await pipeline(Readable.fromWeb(download.body as never), createWriteStream(archivePath))
      this.reportInstallProgress('verible', '下载完成，正在后台解压工具包…', onProgress)
      await this.runProcess(TAR_EXE, ['-xf', archivePath, '-C', veribleDir])
      await rm(archivePath, { force: true })
      const root = this.veribleToolchainDir()
      if (!root) throw new Error('工具包解压完成，但未找到 bin 目录')
      this.activateToolchains()
      return { ok: true, message: 'Verible 安装完成', path: root }
    } catch (error) {
      await rm(archivePath, { force: true }).catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: /abort|timeout/i.test(message) ? '工具包下载超时，请检查网络或代理后重试' : message }
    }
  }

  /** Verible 解压后 bin 所在的目录（zip 内带 verible-v* 顶层目录，按实际结构适配） */
  private veribleToolchainDir(): string | undefined {
    const base = join(this.toolchainRoot, 'verible')
    if (existsSync(join(base, 'bin'))) return base
    if (!existsSync(base)) return undefined
    try {
      for (const entry of readdirSync(base)) {
        const candidate = join(base, entry)
        if (existsSync(join(candidate, 'bin'))) return candidate
      }
    } catch {
      // 目录不可读时视为未安装
    }
    return undefined
  }

  private async installCocotb(onProgress?: (message: string) => void): Promise<ToolInstallResult> {
    const python = await locateTool(process.platform === 'win32' ? ['python.exe', 'python', 'python3.exe'] : ['python3', 'python'])
    if (!python) return { ok: false, message: '未找到可用的 Python，请先安装 Python 3' }
    try {
      this.reportInstallProgress('python-cocotb', '正在通过 pip 安装或升级 Cocotb 组件…', onProgress)
      await this.runProcess(python, ['-m', 'pip', 'install', '--user', '--upgrade', 'cocotb', 'cocotb-bus', 'cocotb-coverage'])
      const check = await this.runProcess(python, ['-c', 'import cocotb; print(cocotb.__version__)'], true)
      return { ok: true, message: `Cocotb 安装完成，版本 ${check.trim()}`, path: python }
    } catch (error) {
      return { ok: false, message: `Cocotb 安装失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async openWaveform(projectId: string, relPath: string): Promise<WaveformOpenResult> {
    this.activateToolchains()
    const root = resolve(this.projects.workspaceDir(projectId))
    const filePath = resolve(root, relPath)
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return { ok: false, error: '波形路径超出项目工作区' }
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return { ok: false, error: `波形文件不存在: ${relPath}` }
    }
    if (!['.vcd', '.fst'].includes(extname(filePath).toLowerCase())) {
      return { ok: false, error: '仅支持打开 VCD/FST 波形文件' }
    }

    const viewer = await locateTool(
      process.platform === 'win32' ? ['gtkwave.exe', 'gtkwave'] : ['gtkwave']
    )
    if (!viewer) {
      return { ok: false, error: '未找到 GTKWave，请先安装并加入 PATH' }
    }

    try {
      await new Promise<void>((resolveLaunch, rejectLaunch) => {
        const viewerBin = dirname(viewer)
        const viewerRoot = resolve(viewerBin, '..')
        const viewerEnv: NodeJS.ProcessEnv = {
          ...process.env,
          // GTK 的图像加载器还依赖工具包之外的系统 DLL；只前置自身目录，不做 MinGW 路径净化。
          PATH: `${viewerBin}${delimiter}${join(viewerRoot, 'lib')}${delimiter}${process.env.PATH ?? ''}`,
          YOSYSHQ_ROOT: `${viewerRoot}${sep}`,
          GTK_EXE_PREFIX: viewerRoot,
          GTK_DATA_PREFIX: viewerRoot,
          GDK_PIXBUF_MODULEDIR: join(viewerRoot, 'lib', 'gdk-pixbuf-2.0', '2.10.0', 'loaders'),
          GDK_PIXBUF_MODULE_FILE: join(viewerRoot, 'lib', 'gdk-pixbuf-2.0', '2.10.0', 'loaders.cache')
        }
        const pixbufQuery = join(viewerRoot, 'lib', process.platform === 'win32' ? 'gdk-pixbuf-query-loaders.exe' : 'gdk-pixbuf-query-loaders')
        const prepare = existsSync(pixbufQuery)
          ? this.runProcess(pixbufQuery, ['--update-cache'], false, viewerEnv)
          : Promise.resolve()

        void prepare.then(() => {
        const startupLog = join(tmpdir(), `moonglass-gtkwave-${Date.now()}-${Math.random().toString(16).slice(2)}.log`)
        const startupLogFd = openSync(startupLog, 'w')
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(viewer, [filePath], {
            cwd: dirname(filePath),
            detached: true,
            stdio: ['ignore', 'ignore', startupLogFd],
            windowsHide: false,
            env: viewerEnv
          })
        } finally {
          closeSync(startupLogFd)
        }
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(readyTimer)
          if (error) rejectLaunch(error)
          else {
            child.unref()
            child.once('exit', () => { void rm(startupLog, { force: true }) })
            resolveLaunch()
          }
        }
        const readyTimer = setTimeout(() => finish(), 2500)
        child.once('error', (error) => finish(error))
        child.once('exit', (code, signal) => {
          if (!settled) {
            const detail = existsSync(startupLog) ? readFileSync(startupLog, 'utf-8').trim().slice(-4000) : ''
            void rm(startupLog, { force: true })
            finish(new Error(`GTKWave 启动后立即退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）${detail ? `：${detail}` : ''}`))
          }
        })
        }).catch(rejectLaunch)
      })
      return { ok: true, viewer }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private bundledArchivePath(): string | undefined {
    if (process.platform !== 'win32' || process.arch !== 'x64') return undefined
    const relativeArchive = join('bundled-toolchains', 'windows-x64', 'moonglass-aigv-runtime.tgz')
    const candidates = [join(process.resourcesPath, relativeArchive), join(process.cwd(), 'resources', 'moonglass', relativeArchive)]
    return candidates.find((candidate) => existsSync(candidate))
  }

  private async ensureBundledAigvRuntime(): Promise<void> {
    const archive = this.bundledArchivePath()
    if (!archive) return
    const archiveStat = statSync(archive); const fingerprint = `${archiveStat.size}:${Math.round(archiveStat.mtimeMs)}`
    const marker = join(this.toolchainRoot, 'bundled-aigv', '.archive-fingerprint')
    if (existsSync(join(this.bundledAigvRoot, 'bin', 'slang.exe')) && existsSync(marker) && readFileSync(marker, 'utf-8') === fingerprint) return
    const target = join(this.toolchainRoot, 'bundled-aigv')
    await rm(target, { recursive: true, force: true }); await mkdir(target, { recursive: true })
    await this.runProcess(TAR_EXE, ['-xzf', archive, '-C', target])
    if (!existsSync(join(this.bundledAigvRoot, 'bin', 'slang.exe')) || !existsSync(join(this.bundledAigvRoot, 'bin', 'sby.cmd'))) throw new Error('MoonGlass 内置 AIGV 工具链解压不完整')
    writeFileSync(marker, fingerprint, 'utf-8')
  }

  private toolSource(path?: string): ToolDetection['source'] {
    if (!path) return undefined
    const normalized = resolve(path).toLowerCase()
    if (normalized.startsWith(resolve(this.bundledAigvRoot).toLowerCase() + sep)) return 'bundled'
    if (normalized.startsWith(resolve(join(this.toolchainRoot, 'oss-cad-suite')).toLowerCase() + sep)) return 'managed'
    if (normalized.startsWith(resolve(join(this.toolchainRoot, 'verible')).toLowerCase() + sep)) return 'managed'
    return 'system'
  }

  private activateToolchains(): void {
    const candidates: Array<string | undefined> = [
      this.bundledAigvRoot,
      join(this.toolchainRoot, 'oss-cad-suite'),
      this.veribleToolchainDir()
    ]
    const roots = candidates.filter((root): root is string => typeof root === 'string' && existsSync(join(root, 'bin')))
    if (roots.length === 0) return
    const priorityDirs = roots.flatMap((root) => [join(root, 'bin'), join(root, 'lib')]).filter(existsSync)
    const selected = new Set(priorityDirs.map((entry) => resolve(entry).toLowerCase()))
    const current = (process.env.PATH ?? '').split(delimiter)
      .filter(Boolean)
      .filter((entry) => !selected.has(resolve(entry).toLowerCase()))
    process.env.PATH = [...priorityDirs, ...current].join(delimiter)
    process.env.MOONGLASS_BUNDLED_AIGV_ROOT = this.bundledAigvRoot
  }

  private runProcess(command: string, args: string[], captureOutput?: false, env?: NodeJS.ProcessEnv): Promise<void>
  private runProcess(command: string, args: string[], captureOutput: true, env?: NodeJS.ProcessEnv): Promise<string>
  private runProcess(command: string, args: string[], captureOutput = false, env?: NodeJS.ProcessEnv): Promise<void | string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, { windowsHide: true, env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-65536) })
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000) })
      child.on('error', reject)
      child.on('close', (code) => code === 0
        ? resolvePromise(captureOutput ? stdout : undefined)
        : reject(new Error(`${command} 执行失败 (code=${code}): ${stderr.trim()}`)))
    })
  }
}
