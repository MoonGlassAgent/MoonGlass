/**
 * EDA 工具服务
 *
 * 对 @moonglass/eda-bridge 的服务化封装。
 * 骨架阶段仅暴露工具探测能力，Lint/仿真/综合待 Phase 4 接入。
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { detectToolchain, locateTool } from '@moonglass/eda-bridge'
import type { ToolDetection, ToolInstallResult, WaveformOpenResult } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'
import { projectWorkspaceDir } from '../core/paths'

export class EdaService implements MoonGlassService {
  readonly name = 'eda-service'
  private readonly toolchainRoot: string
  private static readonly REQUEST_TIMEOUT_MS = 30_000
  private static readonly DOWNLOAD_TIMEOUT_MS = 30 * 60_000

  constructor(userDataDir: string) {
    this.toolchainRoot = join(userDataDir, 'moonglass', 'toolchains')
  }

  async start(): Promise<void> {
    await mkdir(this.toolchainRoot, { recursive: true })
    this.activateManagedTools()
  }

  stop(): void {
    // 无常驻资源
  }

  detectTools(): Promise<ToolDetection[]> {
    this.activateManagedTools()
    return detectToolchain()
  }

  async installBundle(id: string): Promise<ToolInstallResult> {
    if (id === 'python-cocotb') return this.installCocotb()
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
      const download = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': 'MoonGlass' },
        signal: AbortSignal.timeout(EdaService.DOWNLOAD_TIMEOUT_MS)
      })
      if (!download.ok || !download.body) throw new Error(`工具包下载失败: HTTP ${download.status}`)
      await pipeline(Readable.fromWeb(download.body as never), createWriteStream(archivePath))
      await this.runProcess('tar', ['-xzf', archivePath, '-C', this.toolchainRoot])
      await rm(archivePath, { force: true })
      if (!existsSync(join(suiteDir, 'bin'))) throw new Error('工具包解压完成，但未找到 bin 目录')
      this.activateManagedTools()
      return { ok: true, message: 'OSS CAD Suite 安装完成', path: suiteDir }
    } catch (error) {
      await rm(archivePath, { force: true }).catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: /abort|timeout/i.test(message) ? '工具包下载超时，请检查网络或代理后重试' : message }
    }
  }

  private async installCocotb(): Promise<ToolInstallResult> {
    const python = await locateTool(process.platform === 'win32' ? ['python.exe', 'python', 'python3.exe'] : ['python3', 'python'])
    if (!python) return { ok: false, message: '未找到可用的 Python，请先安装 Python 3' }
    try {
      await this.runProcess(python, ['-m', 'pip', 'install', '--user', '--upgrade', 'cocotb', 'cocotb-bus', 'cocotb-coverage'])
      const check = await this.runProcess(python, ['-c', 'import cocotb; print(cocotb.__version__)'], true)
      return { ok: true, message: `Cocotb 安装完成，版本 ${check.trim()}`, path: python }
    } catch (error) {
      return { ok: false, message: `Cocotb 安装失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async openWaveform(projectId: string, relPath: string): Promise<WaveformOpenResult> {
    this.activateManagedTools()
    const root = resolve(projectWorkspaceDir(projectId))
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
      const child = spawn(viewer, [filePath], {
        cwd: dirname(filePath),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      child.unref()
      return { ok: true, viewer }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private activateManagedTools(): void {
    const bin = join(this.toolchainRoot, 'oss-cad-suite', 'bin')
    if (!existsSync(bin)) return
    const current = process.env.PATH ?? ''
    if (!current.toLowerCase().split(delimiter).includes(bin.toLowerCase())) {
      process.env.PATH = `${bin}${delimiter}${current}`
    }
  }

  private runProcess(command: string, args: string[], captureOutput?: false): Promise<void>
  private runProcess(command: string, args: string[], captureOutput: true): Promise<string>
  private runProcess(command: string, args: string[], captureOutput = false): Promise<void | string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-8000) })
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000) })
      child.on('error', reject)
      child.on('close', (code) => code === 0
        ? resolvePromise(captureOutput ? stdout : undefined)
        : reject(new Error(`${command} 执行失败 (code=${code}): ${stderr.trim()}`)))
    })
  }
}
