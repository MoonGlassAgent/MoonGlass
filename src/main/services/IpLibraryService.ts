import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, relative, resolve } from 'node:path'
import type {
  IpLibraryFileKind,
  IpLibraryFileSummary,
  IpLibraryImportInput,
  IpLibraryRecord,
  IpLibrarySource,
  IpTemplateRecord
} from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'

const BUILTIN_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'interface', label: '总线接口' },
  { id: 'memory', label: '存储相关' },
  { id: 'clock', label: '时钟相关' },
  { id: 'arbiter', label: '仲裁器' },
  { id: 'utility', label: '工具模块' }
]

const EXCLUDED_DIRS = /^(?:\.git|node_modules|dist|out|build|obj_dir|sim_build|__pycache__|coverage)$/i
const RTL_EXT = /\.(?:v|sv|vh|svh)$/i
const IP_SOURCE_DIR = /^(?:rtl|src|source|sources|hdl)$/i
const VERIFICATION_DIR = /^(?:tb|test|tests|testbench|verification|verif|sim|vip|bfm|uvm)$/i
const MAX_INDEX_FILES = 80_000
const MAX_EXAMPLES_PER_KIND = 6
const READ_MODULE_BYTES = 192 * 1024

interface IpMetadata {
  name?: unknown
  type?: unknown
  category?: unknown
  topModule?: unknown
  summary?: unknown
  description?: unknown
}

interface ScanSummary {
  fileCount: number
  files: IpLibraryFileSummary[]
  rtlFiles: string[]
  verificationFiles: string[]
  documentFiles: string[]
  constraintFiles: string[]
}

interface SemanticHints {
  protocols: string[]
  interfaceRoles: string[]
}

interface CandidateRoot {
  path: string
  metadataPath?: string
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, '/')
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'root'
}

function fileKind(relPath: string): IpLibraryFileKind {
  const lower = relPath.toLowerCase()
  const ext = extname(lower)
  if (/metadata\.json$|ip\.json$|component\.xml$/.test(lower)) return 'metadata'
  if (/\.(?:sdc|xdc|upf|cpf)$/i.test(lower)) return 'constraint'
  if (/\.(?:md|markdown|rst|txt|pdf|docx?)$/i.test(lower)) return 'document'
  if (/\.(?:py|tcl|sh|bat|ps1|mjs|js|ts|yaml|yml|json)$/i.test(lower)) return 'script'
  if (RTL_EXT.test(lower)) {
    return /(?:^|\/)(?:tb|test|tests|testbench|verification|verif|sim)(?:\/|_)/i.test(lower)
      ? 'verification'
      : 'rtl'
  }
  return ext ? 'other' : 'other'
}

export class IpLibraryService implements MoonGlassService {
  readonly name = 'ip-library-service'

  private readonly root: string
  private readonly builtinRoot: string
  private readonly storePath: string
  private readonly indexPath: string
  private records: IpLibraryRecord[] = []

  constructor(dataDir: string, builtinRoot: string) {
    this.root = join(dataDir, 'moonglass', 'ip-libraries')
    this.builtinRoot = builtinRoot
    this.storePath = join(this.root, 'libraries.json')
    this.indexPath = join(this.root, 'index.json')
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    try {
      this.records = JSON.parse(await readFile(this.storePath, 'utf-8')) as IpLibraryRecord[]
    } catch {
      this.records = []
    }
    let recoveredInterruptedAnalysis = false
    for (const record of this.records) {
      if (record.semanticAnalysisStatus !== 'running') continue
      record.semanticAnalysisStatus = 'failed'
      record.semanticError = '上次 Pi 语义分析因程序退出而中断，请重新运行分析'
      recoveredInterruptedAnalysis = true
    }
    if (recoveredInterruptedAnalysis) await this.persist()
    await this.refreshIndex()
  }

  async stop(): Promise<void> {
    await this.persist()
  }

  async list(): Promise<IpLibraryRecord[]> {
    const libraries = await this.combinedRecords()
    await this.writeIndex(libraries)
    return libraries
  }

  async addLocal(input: IpLibraryImportInput): Promise<IpLibraryRecord> {
    const absolute = resolve(input.path.trim())
    const pathStat = await stat(absolute)
    if (!pathStat.isDirectory()) throw new Error('所选路径不是目录')

    const name = input.name.trim() || basename(absolute)
    const type = input.type.trim() || '用户导入'
    const existing = this.records.find((record) => record.path.toLowerCase() === absolute.toLowerCase())
    if (existing) {
      existing.name = name
      existing.type = type
      existing.status = 'indexing'
      existing.error = undefined
      await this.persist()
      return this.reindex(existing.id)
    }

    const record: IpLibraryRecord = {
      id: randomUUID(),
      name,
      type,
      path: absolute,
      source: 'local',
      status: 'indexing',
      importedAt: new Date().toISOString(),
      ipCount: 0,
      fileCount: 0,
      ips: []
    }
    this.records.push(record)
    await this.persist()
    return this.reindex(record.id)
  }

  async reindex(id: string): Promise<IpLibraryRecord> {
    const builtin = await this.builtinRecordById(id)
    if (builtin) {
      await this.refreshIndex()
      return builtin
    }

    const record = this.records.find((entry) => entry.id === id)
    if (!record) throw new Error('IP 库记录不存在')
    record.status = 'indexing'
    record.error = undefined
    record.semanticAnalysisStatus = 'not-run'
    record.semanticAnalyzedAt = undefined
    record.semanticModel = undefined
    record.semanticError = undefined
    await this.persist()

    try {
      const indexed = await this.scanLibrary(record)
      Object.assign(record, indexed, { source: 'local' as const })
    } catch (error) {
      record.status = existsSync(record.path) ? 'error' : 'missing'
      record.error = error instanceof Error ? error.message : String(error)
      record.indexedAt = new Date().toISOString()
    }
    await this.persist()
    await this.refreshIndex()
    return { ...record, ips: record.ips.map((ip) => ({ ...ip })) }
  }

  async remove(id: string): Promise<boolean> {
    const before = this.records.length
    this.records = this.records.filter((record) => record.id !== id)
    await this.persist()
    await this.refreshIndex()
    return this.records.length < before
  }

  async get(id: string): Promise<IpLibraryRecord | undefined> {
    return (await this.combinedRecords()).find((record) => record.id === id)
  }

  getIndexPath(): string {
    return this.indexPath
  }

  private async combinedRecords(): Promise<IpLibraryRecord[]> {
    return [
      ...(await this.builtinRecords()),
      ...this.records.map((record) => ({
        ...record,
        status: existsSync(record.path) ? record.status : 'missing' as const,
        ips: record.ips.map((ip) => ({ ...ip }))
      }))
    ]
  }

  private async builtinRecordById(id: string): Promise<IpLibraryRecord | undefined> {
    return (await this.builtinRecords()).find((record) => record.id === id)
  }

  private async builtinRecords(): Promise<IpLibraryRecord[]> {
    return Promise.all(
      BUILTIN_CATEGORIES.map(async (category) => {
        const path = join(this.builtinRoot, category.id)
        const base: IpLibraryRecord = {
          id: `builtin-${category.id}`,
          name: `${category.label}（内置）`,
          type: category.label,
          path,
          source: 'builtin',
          status: existsSync(path) ? 'ready' : 'missing',
          ipCount: 0,
          fileCount: 0,
          ips: []
        }
        if (!existsSync(path)) return base
        try {
          return await this.scanLibrary(base)
        } catch (error) {
          return {
            ...base,
            status: 'error',
            indexedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error)
          }
        }
      })
    )
  }

  private async scanLibrary(base: IpLibraryRecord): Promise<IpLibraryRecord> {
    if (!existsSync(base.path)) {
      return { ...base, status: 'missing', error: '目录不存在', indexedAt: new Date().toISOString() }
    }
    const candidates = await this.findCandidateRoots(base.path)
    const ips = await Promise.all(
      candidates.map((candidate) => this.scanIpRoot(base.id, base.path, candidate, base.type, base.source))
    )
    const fileCount = ips.reduce((sum, ip) => sum + ip.fileCount, 0)
    return {
      ...base,
      status: 'ready',
      error: undefined,
      ipCount: ips.length,
      fileCount,
      ips: ips.sort((a, b) => a.name.localeCompare(b.name)),
      indexedAt: new Date().toISOString()
    }
  }

  private async findCandidateRoots(root: string): Promise<CandidateRoot[]> {
    const roots = new Map<string, CandidateRoot>()
    let scannedFiles = 0

    const walk = async (dir: string): Promise<void> => {
      if (scannedFiles >= MAX_INDEX_FILES) return
      const entries = await this.safeReaddir(dir)
      const metadata = entries.find((entry) => entry.isFile() && /^(?:metadata|ip)\.json$/i.test(entry.name))
      const rtlDir = entries.find((entry) => entry.isDirectory() && IP_SOURCE_DIR.test(entry.name))
      const verificationDir = entries.find((entry) => entry.isDirectory() && VERIFICATION_DIR.test(entry.name))
      const hasDirectRtl = entries.some((entry) => entry.isFile() && RTL_EXT.test(entry.name))
      const hasRtlDir = rtlDir ? await this.containsRtl(join(dir, rtlDir.name)) : false
      const hasVerificationDir = verificationDir ? await this.containsRtl(join(dir, verificationDir.name)) : false

      if (metadata || hasRtlDir || hasVerificationDir || hasDirectRtl) {
        roots.set(dir, { path: dir, metadataPath: metadata ? join(dir, metadata.name) : undefined })
        return
      }

      for (const entry of entries) {
        if (entry.isFile()) scannedFiles += 1
        if (!entry.isDirectory() || EXCLUDED_DIRS.test(entry.name)) continue
        await walk(join(dir, entry.name))
        if (scannedFiles >= MAX_INDEX_FILES) break
      }
    }

    await walk(root)
    if (roots.size === 0 && await this.containsRtl(root)) {
      roots.set(root, { path: root })
    }
    return [...roots.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  private async scanIpRoot(
    libraryId: string,
    libraryRoot: string,
    ipRoot: CandidateRoot,
    defaultType: string,
    source: IpLibrarySource
  ): Promise<IpTemplateRecord> {
    const metadata = await this.readMetadata(ipRoot.path)
    const summary = await this.summarizeFiles(ipRoot.path)
    const relRoot = normalizeRel(relative(libraryRoot, ipRoot.path)) || '.'
    const type = text(metadata?.type) ?? text(metadata?.category) ?? defaultType
    const name = text(metadata?.name) ?? (relRoot === '.' ? basename(ipRoot.path) : basename(relRoot))
    const topModule = text(metadata?.topModule) ?? await this.inferTopModule(ipRoot.path, summary.rtlFiles)
    const semanticHints = await this.inferSemanticHints(ipRoot.path, summary)
    const metadataPath = ipRoot.metadataPath ?? await this.findMetadataPath(ipRoot.path)
    const hasDesign = summary.rtlFiles.length > 0
    const hasVerification = summary.verificationFiles.length > 0
    const status = hasDesign || hasVerification ? 'ready' : 'error'
    const componentKind = hasDesign && hasVerification
      ? 'mixed' as const
      : hasVerification ? 'verification-component' as const : hasDesign ? 'rtl-ip' as const : 'reference' as const
    const confidence = metadataPath ? 0.98 : topModule ? 0.86 : hasVerification ? 0.76 : 0.6
    return {
      id: `${libraryId}:${safeIdPart(relRoot)}`,
      libraryId,
      name,
      type,
      path: ipRoot.path,
      source,
      status,
      topModule,
      componentKind,
      protocols: semanticHints.protocols,
      interfaceRoles: semanticHints.interfaceRoles,
      confidence,
      analysisSource: 'deterministic',
      summary: text(metadata?.summary) ?? text(metadata?.description),
      metadataPath,
      fileCount: summary.fileCount,
      files: summary.files,
      rtlFiles: summary.rtlFiles,
      verificationFiles: summary.verificationFiles,
      documentFiles: summary.documentFiles,
      constraintFiles: summary.constraintFiles,
      error: status === 'error' ? '未发现 RTL 或验证组件源文件' : undefined
    }
  }

  private async inferSemanticHints(root: string, summary: ScanSummary): Promise<SemanticHints> {
    const paths = [...summary.rtlFiles, ...summary.verificationFiles]
    let corpus = paths.join('\n').toLowerCase()
    for (const relPath of paths.slice(0, 24)) {
      try {
        corpus += `\n${(await readFile(join(root, relPath), 'utf-8')).slice(0, READ_MODULE_BYTES).toLowerCase()}`
      } catch { /* 单个源文件不可读不影响其余索引 */ }
    }
    const protocols: string[] = []
    const detect = (label: string, pattern: RegExp): void => { if (pattern.test(corpus)) protocols.push(label) }
    detect('AXI4', /\baxi(?:4)?\b|\bawvalid\b|\barvalid\b/)
    detect('AXI4-Lite', /axi[_ -]?lite|axil|\bawaddr\b[\s\S]{0,200}\bwstrb\b/)
    detect('AXI-Stream', /axi[_ -]?stream|axis|\btvalid\b[\s\S]{0,120}\btready\b/)
    detect('AHB', /\bahb\b|\bhtrans\b|\bhready\b/)
    detect('APB', /\bapb\b|\bpsel\b|\bpenable\b/)
    detect('UART', /\buart\b|\btxd\b|\brxd\b/)
    detect('SPI', /\bspi\b|\bmosi\b|\bmiso\b|\bsclk\b/)
    detect('I2C', /\bi2c\b|\bscl\b[\s\S]{0,100}\bsda\b/)
    const interfaceRoles: string[] = []
    if (/\b(master|initiator|mst)\b/.test(corpus)) interfaceRoles.push('master')
    if (/\b(slave|target|slv)\b/.test(corpus)) interfaceRoles.push('slave')
    if (/\bmonitor\b/.test(corpus)) interfaceRoles.push('monitor')
    if (/\b(driver|bfm)\b/.test(corpus)) interfaceRoles.push('driver')
    return { protocols: [...new Set(protocols)], interfaceRoles: [...new Set(interfaceRoles)] }
  }

  private async summarizeFiles(root: string): Promise<ScanSummary> {
    const groups = new Map<IpLibraryFileKind, { count: number; examples: string[] }>()
    const rtlFiles: string[] = []
    const verificationFiles: string[] = []
    const documentFiles: string[] = []
    const constraintFiles: string[] = []
    let fileCount = 0
    const verificationRoot = VERIFICATION_DIR.test(basename(root)) || /(?:vip|bfm|uvm|testbench)/i.test(basename(root))

    const remember = (kind: IpLibraryFileKind, relPath: string): void => {
      const group = groups.get(kind) ?? { count: 0, examples: [] }
      group.count += 1
      if (group.examples.length < MAX_EXAMPLES_PER_KIND) group.examples.push(relPath)
      groups.set(kind, group)
      if (kind === 'rtl') rtlFiles.push(relPath)
      else if (kind === 'verification') verificationFiles.push(relPath)
      else if (kind === 'document') documentFiles.push(relPath)
      else if (kind === 'constraint') constraintFiles.push(relPath)
    }

    const walk = async (dir: string): Promise<void> => {
      if (fileCount >= MAX_INDEX_FILES) return
      for (const entry of await this.safeReaddir(dir)) {
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.test(entry.name)) await walk(join(dir, entry.name))
          continue
        }
        fileCount += 1
        const full = join(dir, entry.name)
        const rel = normalizeRel(relative(root, full))
        const detectedKind = fileKind(rel)
        remember(detectedKind === 'rtl' && verificationRoot ? 'verification' : detectedKind, rel)
        if (fileCount >= MAX_INDEX_FILES) break
      }
    }

    await walk(root)
    return {
      fileCount,
      files: [...groups.entries()].map(([kind, value]) => ({ kind, ...value })).sort((a, b) => b.count - a.count),
      rtlFiles,
      verificationFiles,
      documentFiles,
      constraintFiles
    }
  }

  private async containsRtl(dir: string): Promise<boolean> {
    for (const entry of await this.safeReaddir(dir)) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.test(entry.name) && await this.containsRtl(join(dir, entry.name))) return true
      } else if (RTL_EXT.test(entry.name)) {
        return true
      }
    }
    return false
  }

  private async inferTopModule(root: string, rtlFiles: string[]): Promise<string | undefined> {
    for (const relPath of rtlFiles.slice(0, 8)) {
      const full = join(root, relPath)
      try {
        const content = (await readFile(full, 'utf-8')).slice(0, READ_MODULE_BYTES)
        const withoutLineComments = content.replace(/\/\/.*$/gm, '')
        const match = /\bmodule\s+([a-zA-Z_][a-zA-Z0-9_$]*)\b/.exec(withoutLineComments)
        if (match) return match[1]
      } catch {
        // 忽略无法读取的文件，继续尝试下一个 RTL
      }
    }
    return undefined
  }

  private async readMetadata(root: string): Promise<IpMetadata | undefined> {
    const metadataPath = await this.findMetadataPath(root)
    if (!metadataPath) return undefined
    try {
      return JSON.parse(await readFile(metadataPath, 'utf-8')) as IpMetadata
    } catch {
      return undefined
    }
  }

  private async findMetadataPath(root: string): Promise<string | undefined> {
    for (const name of ['metadata.json', 'ip.json']) {
      const path = join(root, name)
      if (existsSync(path)) return path
    }
    return undefined
  }

  private async safeReaddir(dir: string): Promise<import('node:fs').Dirent[]> {
    try {
      return await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(this.storePath, JSON.stringify(this.records, null, 2), 'utf-8')
  }

  private async refreshIndex(): Promise<void> {
    const libraries = await this.combinedRecords()
    await this.writeIndex(libraries)
    await this.writeGuide(libraries)
  }

  async applySemanticAnalysis(
    id: string,
    result: { model: string; ips: Array<{ id: string; name?: string; type?: string; summary?: string; protocols?: string[]; interfaceRoles?: string[]; licenseStatus?: 'identified' | 'unknown' | 'restricted'; confidence?: number }> }
  ): Promise<IpLibraryRecord> {
    const record = this.records.find((entry) => entry.id === id)
    if (!record) throw new Error('仅支持分析用户导入的 IP 库')
    const byId = new Map(result.ips.map((ip) => [ip.id, ip]))
    record.ips = record.ips.map((ip) => {
      const semantic = byId.get(ip.id)
      if (!semantic) return ip
      return {
        ...ip,
        name: text(semantic.name) ?? ip.name,
        type: text(semantic.type) ?? ip.type,
        summary: text(semantic.summary) ?? ip.summary,
        protocols: Array.isArray(semantic.protocols) ? [...new Set(semantic.protocols.filter((value) => typeof value === 'string'))] : ip.protocols,
        interfaceRoles: Array.isArray(semantic.interfaceRoles) ? [...new Set(semantic.interfaceRoles.filter((value) => typeof value === 'string'))] : ip.interfaceRoles,
        licenseStatus: semantic.licenseStatus ?? ip.licenseStatus ?? 'unknown',
        confidence: typeof semantic.confidence === 'number' ? Math.max(0, Math.min(1, semantic.confidence)) : ip.confidence,
        analysisSource: 'pi'
      }
    })
    record.semanticAnalysisStatus = 'completed'
    record.semanticAnalyzedAt = new Date().toISOString()
    record.semanticModel = result.model
    record.semanticError = undefined
    await this.persist()
    await this.refreshIndex()
    return { ...record, ips: record.ips.map((ip) => ({ ...ip })) }
  }

  async markSemanticAnalysis(id: string, status: 'running' | 'failed', error?: string): Promise<void> {
    const record = this.records.find((entry) => entry.id === id)
    if (!record) throw new Error('仅支持分析用户导入的 IP 库')
    record.semanticAnalysisStatus = status
    record.semanticError = error
    await this.persist()
  }

  private async writeIndex(libraries: IpLibraryRecord[]): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(
      this.indexPath,
      JSON.stringify({
        version: 2,
        generatedAt: new Date().toISOString(),
        builtinRoot: this.builtinRoot,
        libraries
      }, null, 2),
      'utf-8'
    )
  }

  private async writeGuide(libraries: IpLibraryRecord[]): Promise<void> {
    const readyIps = libraries.flatMap((library) => library.ips.map((ip) => ({ library, ip })))
    const lines = [
      '# MoonGlass IP Library Guide',
      '',
      `生成时间：${new Date().toISOString()}`,
      '',
      '本文件由确定性索引器生成。Agent 应先从 `index.json` 按功能、协议和组件用途检索，再读取候选 IP 源文件；不得仅凭名称直接集成。',
      '',
      '## 使用约束',
      '',
      '- IP 库默认只读；项目修改应通过 wrapper、adapter 或项目内受控副本完成。',
      '- 架构和 RTL 阶段优先评估 `rtl-ip` 或 `mixed`；验证阶段优先评估 `verification-component` 或 `mixed`。',
      '- 使用前核对接口角色、协议、参数、时钟复位、依赖、许可证和质量证据。',
      '- 候选不满足需求时允许不用，并记录不采用原因。',
      '',
      '## 已索引 IP',
      ''
    ]
    for (const { library, ip } of readyIps) {
      lines.push(
        `### ${ip.name}`,
        '',
        `- 库：${library.name}`,
        `- 类型：${ip.type} / ${ip.componentKind ?? '待分析'}`,
        `- 协议：${ip.protocols?.join('、') || '未识别'}`,
        `- 接口角色：${ip.interfaceRoles?.join('、') || '未识别'}`,
        `- Top：${ip.topModule ?? '未识别'}`,
        `- 路径：${ip.path.replace(/\\/g, '/')}`,
        `- 置信度：${Math.round((ip.confidence ?? 0) * 100)}%`,
        ''
      )
    }
    await writeFile(join(this.root, 'IP_LIBRARY_GUIDE.md'), `${lines.join('\n')}\n`, 'utf-8')
  }
}
