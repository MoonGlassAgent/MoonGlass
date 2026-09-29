/**
 * EDA 工具服务
 *
 * 对 @moonglass/eda-bridge 的服务化封装。
 * 提供工具探测、缺失工具一键安装（OSS CAD Suite / Verible / Cocotb）、
 * 系统 PATH 刷新与 GTKWave 波形打开能力。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path'
import { computeMissingInstallPlan, detectToolchain, downloadFileWithMirrors, isCocotbVersionCompatible, locateTool, mergePathEntries, releaseDownloadUrl, releasePageUrl, run, runCocotbSimulation, runFormalVerification, toolEnv, verifyIcarusToolchain, COCOTB_VERSION_RANGE, TOOLCHAIN_MANIFEST, VERIBLE_CANDIDATES, YOSYS_CANDIDATES } from '@moonglass/eda-bridge'
import type { EnvSelfCheckItem, EnvSelfCheckReport, InstallMissingSummary, ToolDetection, ToolInstallJob, ToolInstallResult, WaveformOpenResult } from '@shared/types'
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
  private readonly selfCheckRoot: string
  private detectionCache: ToolDetection[] | null = null
  private readonly installJobs = new Map<string, ToolInstallJob>()
  private readonly projects: ProjectService
  private static readonly DOWNLOAD_TIMEOUT_MS = 30 * 60_000
  /** 一键安装缺失工具的编排任务固定 id（复用 installJobs 轮询） */
  static readonly INSTALL_MISSING_JOB_ID = 'install-missing'

  // 显式字段赋值而非 TS 参数属性：冒烟脚本在 Node strip-only 模式下直接 import 本文件，
  // 参数属性语法不被支持（与 ProjectService 同一写法约定）
  constructor(userDataDir: string, projects: ProjectService) {
    this.projects = projects
    this.toolchainRoot = join(userDataDir, 'moonglass', 'toolchains')
    this.bundledAigvRoot = join(this.toolchainRoot, 'bundled-aigv', 'aigv-toolchain')
    this.detectionCachePath = join(userDataDir, 'moonglass', 'eda-detection-cache.json')
    this.selfCheckRoot = join(userDataDir, 'moonglass', 'self-check')
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

  /**
   * 用户侧环境自检（T6 env doctor）：不依赖任何项目或仓库源码，
   * 在 <userData>/moonglass/self-check/（每次运行前清空重建，文件名纯 ASCII）下
   * 逐项执行 5 条最小端到端链路，逐项收敛为 PASS / FAIL / 跳过 + 修复指引。
   * 执行前经 activateToolchains() 注入自管工具链 PATH；所有工具调用走 toolEnv
   * （MinGW DLL 隔离、VERILATOR_ROOT 修正），文件一律以 cwd + 相对路径传给工具
   * （中文用户名下 userData 路径含非 ASCII 时也能跑）。整体可能耗时约 1 分钟，
   * IPC 侧不设超时。
   */
  async runEnvironmentSelfCheck(): Promise<EnvSelfCheckReport> {
    this.activateToolchains()
    await rm(this.selfCheckRoot, { recursive: true, force: true })
    await mkdir(this.selfCheckRoot, { recursive: true })
    const items: EnvSelfCheckItem[] = [
      await this.runSelfCheckItem('icarus', 'oss-cad-suite', () => this.checkIcarusMinimal()),
      await this.runSelfCheckItem('verible', 'verible', () => this.checkVeribleMinimal()),
      await this.runSelfCheckItem('yosys', 'oss-cad-suite', () => this.checkYosysMinimal()),
      await this.runSelfCheckItem('sby', 'oss-cad-suite', () => this.checkSbyMinimal()),
      await this.runSelfCheckItem('cocotb', 'python-cocotb', () => this.checkCocotbMinimal())
    ]
    return { items, passedCount: items.filter((item) => item.passed).length, totalCount: items.length, ranAt: new Date().toISOString() }
  }

  /** 单项检查收敛：检查函数返回 string 为 PASS 明细；返回 { skipped, message } 为工具缺失跳过；抛错为 FAIL */
  private async runSelfCheckItem(
    id: EnvSelfCheckItem['id'],
    installId: string,
    check: () => Promise<string | { skipped: true; message: string; installId?: string }>
  ): Promise<EnvSelfCheckItem> {
    const startedAt = Date.now()
    try {
      const result = await check()
      if (typeof result !== 'string') {
        return { id, passed: false, skipped: true, message: result.message, durationMs: Date.now() - startedAt, installId: result.installId ?? installId }
      }
      return { id, passed: true, message: result, durationMs: Date.now() - startedAt }
    } catch (error) {
      return { id, passed: false, message: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, installId }
    }
  }

  /** icarus：locate iverilog → verifyIcarusToolchain 最小编译 + 运行（MOONGLASS_ICARUS_OK 标记） */
  private async checkIcarusMinimal(): Promise<string | { skipped: true; message: string }> {
    const iverilog = await locateTool(process.platform === 'win32' ? ['iverilog.exe', 'iverilog'] : ['iverilog'])
    if (!iverilog) return { skipped: true, message: '未找到 Icarus Verilog（iverilog）；请通过下方安装入口安装 OSS CAD Suite' }
    const env = toolEnv(iverilog)
    const version = await run(iverilog, ['-V'], env)
    await verifyIcarusToolchain(iverilog, this.selfCheckRoot, env)
    const versionLine = (version.stdout || version.stderr).trim().split(/\r?\n/)[0] ?? ''
    return `最小编译与运行通过（${versionLine || '版本未知'}）`
  }

  /** verible：复用安装后自检同款检查（--version + 最小 SV lint）；工具缺失则跳过 */
  private async checkVeribleMinimal(): Promise<string | { skipped: true; message: string }> {
    const lintExe = await locateTool(VERIBLE_CANDIDATES)
    if (!lintExe) return { skipped: true, message: '未找到 Verible（verible-verilog-lint）；请通过下方安装入口安装 Verible' }
    const versionLine = await this.selfCheckVeribleBinary(lintExe)
    return `最小 SystemVerilog lint 通过（${versionLine || '版本未知'}）`
  }

  /** yosys+ABC：最小模块含算术（a - b）触发 ABC 映射，read_verilog + synth -top + stat 全链路；
   *  以 cwd=工作目录、相对文件名运行，覆盖 yosys-abc 缺失类问题 */
  private async checkYosysMinimal(): Promise<string | { skipped: true; message: string }> {
    const yosys = await locateTool(YOSYS_CANDIDATES)
    if (!yosys) return { skipped: true, message: '未找到 Yosys；请通过下方安装入口安装 OSS CAD Suite' }
    const env = toolEnv(yosys)
    const checkDir = join(this.selfCheckRoot, 'yosys')
    mkdirSync(checkDir, { recursive: true })
    writeFileSync(join(checkDir, 'min.v'), 'module top(input [7:0] a, input [7:0] b, output [8:0] d);\n  assign d = a - b;\nendmodule\n', 'utf-8')
    const version = await run(yosys, ['-V'], env)
    const synth = await run(yosys, ['-p', 'read_verilog min.v; synth -top top; stat'], env, undefined, checkDir, 120_000)
    if (synth.code !== 0) {
      throw new Error(`yosys 最小综合失败（退出码 ${synth.code ?? 'null'}）：${(synth.stderr || synth.stdout).trim().slice(-1500) || '无输出'}`)
    }
    const versionLine = (version.stdout || version.stderr).trim().split(/\r?\n/)[0] ?? ''
    return `最小模块综合（含 ABC 映射）通过（${versionLine || '版本未知'}）`
  }

  /** sby bmc：最小 .sby（bmc 模式 + smtbmc boolector）+ 自反断言模块，
   *  走 runFormalVerification 既有口径（相对路径、cwd 传递、非 ASCII 编码防线），
   *  覆盖 sby / MinGW Python / 求解器完整链路（内部超时 15 分钟，足够冷启动） */
  private async checkSbyMinimal(): Promise<string | { skipped: true; message: string }> {
    const sby = await locateTool(process.platform === 'win32' ? ['sby.exe', 'sby.cmd', 'sby'] : ['sby'])
    if (!sby) return { skipped: true, message: '未找到 SymbiYosys（sby）；请通过下方安装入口安装 OSS CAD Suite' }
    const checkDir = join(this.selfCheckRoot, 'sby')
    mkdirSync(checkDir, { recursive: true })
    // 单文件同时作为 RTL 与属性输入：always 时序块内的 immediate assert（Yosys formal 子集内）
    writeFileSync(join(checkDir, 'top.v'), 'module top(input clk, input rst);\n  reg [3:0] cnt;\n  always @(posedge clk) begin\n    if (rst) cnt <= 4\'d0;\n    else cnt <= cnt + 4\'d1;\n    assert (cnt == cnt);\n  end\nendmodule\n', 'utf-8')
    const result = await runFormalVerification({
      workspaceDir: checkDir,
      top: 'top',
      rtlFiles: ['top.v'],
      propertyFiles: ['top.v'],
      mode: 'bmc',
      depth: 5,
      engine: 'boolector',
      taskName: 'selfcheck'
    })
    if (result.status !== 'PASS') {
      throw new Error(`SymbiYosys 最小 BMC 未通过（状态 ${result.status}）：${result.message}`)
    }
    return `最小断言 BMC 通过（engine=smtbmc ${result.engine}，depth=${result.depth}）`
  }

  /** cocotb+icarus：cocotb 版本范围校验 + runCocotbSimulation 跑 1 断言最小用例
   *  （runner 生成、pin 版本、JUnit 产出全链路；waves:false + rtlCoverage:false 锁定 icarus 后端） */
  private async checkCocotbMinimal(): Promise<string | { skipped: true; message: string; installId?: string }> {
    const python = await locateTool(process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python'])
    if (!python) return { skipped: true, message: '未找到 Python 3；Cocotb 运行需要 Python，请先安装 Python 3' }
    const probe = await run(python, ['-c', 'import cocotb; print(cocotb.__version__)'], undefined, undefined, undefined, 30_000)
    if (probe.code !== 0) {
      return { skipped: true, message: '当前 Python 未安装 Cocotb；请通过下方安装入口安装 Cocotb' }
    }
    const version = probe.stdout.trim().split(/\r?\n/)[0] ?? ''
    if (!isCocotbVersionCompatible(version)) {
      throw new Error(`cocotb 版本 ${version || '未知'} 不在支持范围（${COCOTB_VERSION_RANGE}）；请执行：pip install --user --upgrade "cocotb==${TOOLCHAIN_MANIFEST['python-cocotb'].pinnedVersion}"`)
    }
    const iverilog = await locateTool(process.platform === 'win32' ? ['iverilog.exe', 'iverilog'] : ['iverilog'])
    if (!iverilog) return { skipped: true, message: 'Cocotb 仿真依赖 Icarus Verilog（iverilog），未找到；请安装 OSS CAD Suite', installId: 'oss-cad-suite' }
    const checkDir = join(this.selfCheckRoot, 'cocotb')
    const tbDir = join(checkDir, 'tb')
    mkdirSync(tbDir, { recursive: true })
    writeFileSync(join(checkDir, 'top.v'), 'module top(input clk);\n  reg [3:0] cnt;\n  always @(posedge clk) cnt <= cnt + 4\'d1;\nendmodule\n', 'utf-8')
    // cocotb 2.x 写法：Timer 的 unit= 单数参数
    writeFileSync(join(tbDir, 'test_min.py'), 'import cocotb\nfrom cocotb.triggers import Timer\n\n\n@cocotb.test()\nasync def test_min_sanity(dut):\n    await Timer(1, unit="ns")\n    assert True\n', 'utf-8')
    const result = await runCocotbSimulation({
      topModule: 'top',
      rtlFiles: [join(checkDir, 'top.v')],
      testModule: 'test_min',
      testDir: tbDir,
      simulator: 'icarus',
      waves: false,
      rtlCoverage: false,
      buildDir: join(checkDir, 'build'),
      resultDir: join(checkDir, 'results'),
      timeoutSec: 120
    })
    if (!result.passed) {
      throw new Error(`cocotb 最小用例未通过：${result.log.slice(-1200)}`)
    }
    return `cocotb ${version} + Icarus 最小用例通过（1 个断言，JUnit 已产出）`
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
      if (cached.version === 3 && cached.platform === process.platform && cached.arch === process.arch && Array.isArray(cached.tools)) {
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
        // v3：ToolDetection 增加 versionCompatible/versionHint（cocotb 版本范围校验结果）
        version: 3,
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
    if (id === 'verible') return `正在下载 Verible（固定版本 ${TOOLCHAIN_MANIFEST.verible.pinnedTag}）…`
    return `正在下载 OSS CAD Suite（固定版本 ${TOOLCHAIN_MANIFEST['oss-cad-suite'].pinnedTag}）…`
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

    const pin = TOOLCHAIN_MANIFEST['oss-cad-suite']
    const suiteDir = join(this.toolchainRoot, 'oss-cad-suite')
    const archivePath = join(this.toolchainRoot, pin.assetName)
    try {
      // T3：版本钉死——直接下载 pinned release 资产（不再查询 releases/latest），
      // 镜像回退由 download.ts 继续生效（github.com URL 加镜像前缀）
      const downloadUrl = releaseDownloadUrl(pin)
      await rm(suiteDir, { recursive: true, force: true })
      const { channel } = await downloadFileWithMirrors(downloadUrl, archivePath, {
        timeoutMs: EdaService.DOWNLOAD_TIMEOUT_MS,
        onChannel: (ch) => this.reportInstallProgress(id, `正在下载 OSS CAD Suite（${ch}），请保持网络连接…`, onProgress)
      })
      this.reportInstallProgress(id, '下载完成，正在校验安装包完整性（sha256）…', onProgress)
      await this.verifyArchiveSha256(archivePath, pin.sha256)
      this.reportInstallProgress(id, '校验通过，正在后台解压工具包…', onProgress)
      await this.runProcess(TAR_EXE, ['-xzf', archivePath, '-C', this.toolchainRoot])
      await rm(archivePath, { force: true })
      if (!existsSync(join(suiteDir, 'bin'))) throw new Error('工具包解压完成，但未找到 bin 目录')
      this.reportInstallProgress(id, '解压完成，正在运行安装后自检…', onProgress)
      try {
        await this.selfCheckOssCadSuite(suiteDir)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`OSS CAD Suite 安装后自检未通过：${detail}。请在“设置 > 工具链”重试安装，或从 ${releasePageUrl(pin)} 手动下载安装`)
      }
      this.activateToolchains()
      return { ok: true, message: `OSS CAD Suite 安装完成（${pin.pinnedTag}，下载自 ${channel}，自检通过）`, path: suiteDir }
    } catch (error) {
      await rm(archivePath, { force: true }).catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    }
  }

  /** 安装包完整性校验：下载完成后核对 sha256，不匹配立即失败（不进入解压），消息含期望/实际哈希 */
  private async verifyArchiveSha256(archivePath: string, expectedSha256: string): Promise<void> {
    const actual = await new Promise<string>((resolvePromise, reject) => {
      const hash = createHash('sha256')
      createReadStream(archivePath)
        .on('error', reject)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => resolvePromise(hash.digest('hex')))
    })
    if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(`安装包完整性校验失败（下载损坏或被篡改）：期望 sha256=${expectedSha256}，实际 sha256=${actual}。安装包已拦截、未解压；请重试安装`)
    }
  }

  /**
   * OSS CAD Suite 安装后真自检（T3；T6 环境自检复用入口）：
   * yosys -V / iverilog -V 可执行 + verifyIcarusToolchain 最小编译运行。
   * 失败抛出指名缺失项的错误。env 走 toolEnv 以获得 MinGW DLL 隔离。
   */
  private async selfCheckOssCadSuite(suiteDir: string): Promise<void> {
    const binDir = join(suiteDir, 'bin')
    const yosys = join(binDir, process.platform === 'win32' ? 'yosys.exe' : 'yosys')
    const iverilog = join(binDir, process.platform === 'win32' ? 'iverilog.exe' : 'iverilog')
    if (!existsSync(yosys)) throw new Error('缺少 yosys（bin 目录下未找到 yosys 可执行文件）')
    if (!existsSync(iverilog)) throw new Error('缺少 iverilog（bin 目录下未找到 iverilog 可执行文件）')
    const yosysCheck = await run(yosys, ['-V'], toolEnv(yosys))
    if (yosysCheck.code !== 0) {
      throw new Error(`yosys -V 执行失败（退出码 ${yosysCheck.code ?? 'null'}）：${(yosysCheck.stderr || yosysCheck.stdout).trim() || '无输出'}`)
    }
    const icarusEnv = toolEnv(iverilog)
    const iverilogCheck = await run(iverilog, ['-V'], icarusEnv)
    if (iverilogCheck.code !== 0) {
      throw new Error(`iverilog -V 执行失败（退出码 ${iverilogCheck.code ?? 'null'}）：${(iverilogCheck.stderr || iverilogCheck.stdout).trim() || '无输出'}`)
    }
    await verifyIcarusToolchain(iverilog, join(this.toolchainRoot, '.self-check'), icarusEnv)
  }

  /**
   * 安装 Verible：T3 起 pin 到 toolchain-manifest 的具体 release（直链下载 + sha256 校验 +
   * 安装后真自检），不再查询 releases/latest。用系统 bsdtar 解压（libarchive 直接支持 zip）。
   * zip 内为 verible-v*-win64/bin 结构，解压到 toolchains/verible/ 下，
   * 实际 bin 所在目录由 veribleToolchainDir 发现。
   */
  private async installVerible(onProgress?: (message: string) => void): Promise<ToolInstallResult> {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      return { ok: false, message: '当前一键安装暂时仅支持 Windows x64' }
    }
    const pin = TOOLCHAIN_MANIFEST.verible
    const veribleDir = join(this.toolchainRoot, 'verible')
    const archivePath = join(this.toolchainRoot, pin.assetName)
    try {
      const downloadUrl = releaseDownloadUrl(pin)
      await rm(veribleDir, { recursive: true, force: true })
      await mkdir(veribleDir, { recursive: true })
      const { channel } = await downloadFileWithMirrors(downloadUrl, archivePath, {
        timeoutMs: EdaService.DOWNLOAD_TIMEOUT_MS,
        onChannel: (ch) => this.reportInstallProgress('verible', `正在下载 Verible（${ch}），请保持网络连接…`, onProgress)
      })
      this.reportInstallProgress('verible', '下载完成，正在校验安装包完整性（sha256）…', onProgress)
      await this.verifyArchiveSha256(archivePath, pin.sha256)
      this.reportInstallProgress('verible', '校验通过，正在后台解压工具包…', onProgress)
      await this.runProcess(TAR_EXE, ['-xf', archivePath, '-C', veribleDir])
      await rm(archivePath, { force: true })
      // win64 zip 的 exe 直接在 verible-v*-win64/ 顶层（无 bin/ 子目录）；
      // 归一化为 bin/ 结构，与 activateToolchains 的 bin/lib 前置约定对齐
      for (const entry of readdirSync(veribleDir)) {
        const extracted = join(veribleDir, entry)
        if (!statSync(extracted).isDirectory()) continue
        if (existsSync(join(extracted, 'bin'))) continue
        const lintExe = process.platform === 'win32' ? 'verible-verilog-lint.exe' : 'verible-verilog-lint'
        if (!existsSync(join(extracted, lintExe))) continue
        const binDir = join(extracted, 'bin')
        mkdirSync(binDir, { recursive: true })
        for (const file of readdirSync(extracted)) {
          if (file.endsWith('.exe') || file === lintExe) renameSync(join(extracted, file), join(binDir, file))
        }
      }
      const root = this.veribleToolchainDir()
      if (!root) throw new Error('工具包解压完成，但未找到 bin 目录')
      this.reportInstallProgress('verible', '解压完成，正在运行安装后自检…', onProgress)
      try {
        await this.selfCheckVerible(root)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Verible 安装后自检未通过：${detail}。请在“设置 > 工具链”重试安装，或从 ${releasePageUrl(pin)} 手动下载安装`)
      }
      this.activateToolchains()
      return { ok: true, message: `Verible 安装完成（${pin.pinnedTag}，下载自 ${channel}，自检通过）`, path: root }
    } catch (error) {
      await rm(archivePath, { force: true }).catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    }
  }

  /**
   * Verible 安装后真自检（T3；T6 环境自检复用入口）：verible-verilog-lint --version 可执行
   * + 对一个临时内联最小 SV 文件 lint。临时文件放 userData 下纯 ASCII 目录，
   * 以 cwd 相对路径传参（规避中文用户名路径问题）；env 走 toolEnv 以获得 MinGW DLL 隔离。
   */
  private async selfCheckVerible(toolchainDir: string): Promise<void> {
    const lintExe = join(toolchainDir, 'bin', process.platform === 'win32' ? 'verible-verilog-lint.exe' : 'verible-verilog-lint')
    if (!existsSync(lintExe)) throw new Error('缺少 verible-verilog-lint（bin 目录下未找到可执行文件）')
    await this.selfCheckVeribleBinary(lintExe)
  }

  /**
   * verible-verilog-lint 可执行文件级自检（安装后自检与 T6 环境自检共用）：
   * --version 可执行 + 最小 SV 文件 lint。临时文件放 userData 下纯 ASCII 目录，
   * 以 cwd 相对路径传参（规避中文用户名路径问题）；env 走 toolEnv 以获得 MinGW DLL 隔离。
   * 返回 --version 首行，供自检报告展示。
   */
  private async selfCheckVeribleBinary(lintExe: string): Promise<string> {
    const env = toolEnv(lintExe)
    const version = await run(lintExe, ['--version'], env)
    if (version.code !== 0) {
      throw new Error(`verible-verilog-lint --version 执行失败（退出码 ${version.code ?? 'null'}）：${(version.stderr || version.stdout).trim() || '无输出'}`)
    }
    const checkDir = join(this.toolchainRoot, '.self-check', 'verible')
    mkdirSync(checkDir, { recursive: true })
    writeFileSync(join(checkDir, 'smoke.sv'), 'module smoke;\n  logic a;\nendmodule\n', 'utf-8')
    try {
      const lint = await run(lintExe, ['smoke.sv'], env, undefined, checkDir)
      if (lint.code !== 0) {
        throw new Error(`verible-verilog-lint 最小文件 lint 未通过（退出码 ${lint.code ?? 'null'}）：${(lint.stderr || lint.stdout).trim() || '无输出'}`)
      }
    } finally {
      rmSync(checkDir, { recursive: true, force: true })
    }
    return (version.stdout || version.stderr).trim().split(/\r?\n/)[0] ?? ''
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
    const pin = TOOLCHAIN_MANIFEST['python-cocotb']
    try {
      // T1：cocotb 按 manifest pin 精确版本安装（cocotb-bus/cocotb-coverage 维持不 pin）
      this.reportInstallProgress('python-cocotb', `正在通过 pip 安装或升级 Cocotb 组件（cocotb==${pin.pinnedVersion}）…`, onProgress)
      await this.runProcess(python, ['-m', 'pip', 'install', ...pin.pipInstallArgs])
      const check = await this.runProcess(python, ['-c', 'import cocotb; print(cocotb.__version__)'], true)
      const version = check.trim().split(/\r?\n/)[0] ?? ''
      // 装后版本回显升级为范围校验：不兼容判安装失败，指明实际版本与期望 pin
      if (!isCocotbVersionCompatible(version)) {
        return {
          ok: false,
          message: `Cocotb 安装后版本校验失败：实际装到 ${version || '未知版本'}，不在支持范围 ${COCOTB_VERSION_RANGE}（期望 pin cocotb==${pin.pinnedVersion}）。请检查 pip 源与缓存后重试，或手动执行：pip install --user --upgrade "cocotb==${pin.pinnedVersion}"`
        }
      }
      return { ok: true, message: `Cocotb 安装完成，版本 ${version}`, path: python }
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
