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
      const rtlDir = entries.find((entry) => entry.isDirectory() && /^rtl$/i.test(entry.name))
      const hasDirectRtl = entries.some((entry) => entry.isFile() && RTL_EXT.test(entry.name))
      const hasRtlDir = rtlDir ? await this.containsRtl(join(dir, rtlDir.name)) : false

      if (metadata || hasRtlDir || (dir === root && hasDirectRtl)) {
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
    const metadataPath = ipRoot.metadataPath ?? await this.findMetadataPath(ipRoot.path)
    const status = summary.rtlFiles.length > 0 ? 'ready' : 'error'
    return {
      id: `${libraryId}:${safeIdPart(relRoot)}`,
      libraryId,
      name,
      type,
      path: ipRoot.path,
      source,
      status,
      topModule,
      summary: text(metadata?.summary) ?? text(metadata?.description),
      metadataPath,
      fileCount: summary.fileCount,
      files: summary.files,
      rtlFiles: summary.rtlFiles,
      verificationFiles: summary.verificationFiles,
      documentFiles: summary.documentFiles,
      constraintFiles: summary.constraintFiles,
      error: status === 'error' ? '未发现 RTL 源文件' : undefined
    }
  }

  private async summarizeFiles(root: string): Promise<ScanSummary> {
    const groups = new Map<IpLibraryFileKind, { count: number; examples: string[] }>()
    const rtlFiles: string[] = []
    const verificationFiles: string[] = []
    const documentFiles: string[] = []
    const constraintFiles: string[] = []
    let fileCount = 0

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
        remember(fileKind(rel), rel)
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
    await this.writeIndex(await this.combinedRecords())
  }

  private async writeIndex(libraries: IpLibraryRecord[]): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(
      this.indexPath,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        builtinRoot: this.builtinRoot,
        libraries
      }, null, 2),
      'utf-8'
    )
  }
}
