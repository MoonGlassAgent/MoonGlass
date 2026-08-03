import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { OpenProcessLibrary, ProcessLibraryFileKind, ProcessLibraryRecord } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'

interface CatalogEntry extends Omit<OpenProcessLibrary, 'installed'> {
  cloneArgs?: string[]
  sparsePath?: string
  recursiveSubmodules?: boolean
}

const CATALOG: CatalogEntry[] = [
  {
    id: 'nangate45', name: 'Nangate45', node: '45 nm', license: 'BSD-3-Clause / platform-specific', maturity: 'reference',
    description: 'OpenROAD 数字实现参考平台，包含可直接用于 Yosys/OpenROAD 的 Liberty、LEF、GDS 和 Verilog 视图。',
    repository: 'https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts.git',
    cloneArgs: ['--filter=blob:none', '--sparse'], sparsePath: 'flow/platforms/nangate45'
  },
  {
    id: 'sky130', name: 'SkyWater SKY130', node: '130 nm', license: 'Apache-2.0', maturity: 'experimental',
    description: 'SkyWater 130 nm 开源 PDK。仓库包含子模块，下载体积较大，当前公开版本仍需按文档评估适用性。',
    repository: 'https://github.com/fossi-foundation/skywater-pdk.git', recursiveSubmodules: true
  },
  {
    id: 'gf180mcu', name: 'GlobalFoundries GF180MCU', node: '180 nm', license: 'Apache-2.0', maturity: 'experimental',
    description: 'GlobalFoundries 180 nm MCU 开源 PDK，公开项目标注为 experimental preview。',
    repository: 'https://github.com/fossi-foundation/gf180mcu-pdk.git', recursiveSubmodules: true
  },
  {
    id: 'asap7', name: 'ASAP7', node: '7 nm predictive', license: 'Research use / platform-specific', maturity: 'research',
    description: '面向学术研究的预测性 7 nm FinFET 设计套件，不对应可投片的量产工艺。',
    repository: 'https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts.git',
    cloneArgs: ['--filter=blob:none', '--sparse'], sparsePath: 'flow/platforms/asap7'
  }
]

const KIND_BY_EXT: Record<string, ProcessLibraryFileKind> = {
  '.lib': 'liberty', '.liberty': 'liberty', '.lef': 'lef', '.tlef': 'lef',
  '.gds': 'gds', '.gdsii': 'gds', '.v': 'verilog', '.sv': 'verilog',
  '.sp': 'spice', '.spi': 'spice', '.spice': 'spice', '.cdl': 'spice',
  '.tf': 'tech', '.tech': 'tech', '.lyt': 'tech', '.lyp': 'tech',
  '.map': 'mapping', '.layermap': 'mapping'
}

const MAX_INDEX_FILES = 250_000

export class ProcessLibraryService implements MoonGlassService {
  readonly name = 'process-library-service'
  private readonly root: string
  private readonly storePath: string
  private readonly indexPath: string
  private records: ProcessLibraryRecord[] = []

  constructor(dataDir: string) {
    this.root = join(dataDir, 'moonglass', 'process-libraries')
    this.storePath = join(this.root, 'libraries.json')
    this.indexPath = join(this.root, 'index.json')
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    try { this.records = JSON.parse(await readFile(this.storePath, 'utf-8')) as ProcessLibraryRecord[] } catch { this.records = [] }
    for (const record of this.records) {
      if (record.catalogId === 'nangate45' && !record.defaultLibertyPath && existsSync(record.path)) {
        await this.reindex(record.id)
      }
    }
    await this.persist()
  }

  async stop(): Promise<void> { await this.persist() }

  list(): ProcessLibraryRecord[] {
    return this.records.map((record) => ({ ...record, status: existsSync(record.path) ? record.status : 'missing' }))
  }

  catalog(): OpenProcessLibrary[] {
    return CATALOG.map(({ cloneArgs: _cloneArgs, sparsePath: _sparsePath, recursiveSubmodules: _recursive, ...entry }) => ({
      ...entry,
      installed: this.records.some((record) => record.catalogId === entry.id && existsSync(record.path))
    }))
  }

  async addLocal(path: string): Promise<ProcessLibraryRecord> {
    const absolute = resolve(path)
    if (!(await stat(absolute)).isDirectory()) throw new Error('所选路径不是目录')
    const existing = this.records.find((record) => record.path.toLowerCase() === absolute.toLowerCase())
    if (existing) return this.reindex(existing.id)
    const record: ProcessLibraryRecord = {
      id: randomUUID(), name: basename(absolute), path: absolute, source: 'local', status: 'indexing', fileCount: 0, files: []
    }
    this.records.push(record)
    await this.persist()
    return this.reindex(record.id)
  }

  async download(catalogId: string): Promise<ProcessLibraryRecord> {
    const item = CATALOG.find((entry) => entry.id === catalogId)
    if (!item) throw new Error(`未知开源工艺库: ${catalogId}`)
    const destination = join(this.root, 'downloads', item.id)
    if (existsSync(destination) && !existsSync(join(destination, '.git'))) {
      await rm(destination, { recursive: true, force: true })
    }
    if (!existsSync(destination)) {
      await mkdir(join(this.root, 'downloads'), { recursive: true })
      try {
        await this.runGit(['clone', '--depth', '1', ...(item.recursiveSubmodules ? ['--recurse-submodules'] : []), ...(item.cloneArgs ?? []), item.repository, destination])
        if (item.sparsePath) await this.runGit(['-C', destination, 'sparse-checkout', 'set', item.sparsePath])
      } catch (error) {
        await rm(destination, { recursive: true, force: true })
        throw error
      }
    }
    let record = this.records.find((entry) => entry.catalogId === catalogId)
    if (!record) {
      record = { id: randomUUID(), name: item.name, path: destination, source: 'downloaded', catalogId, status: 'indexing', fileCount: 0, files: [] }
      this.records.push(record)
    }
    await this.persist()
    return this.reindex(record.id)
  }

  async reindex(id: string): Promise<ProcessLibraryRecord> {
    const record = this.records.find((entry) => entry.id === id)
    if (!record) throw new Error('工艺库记录不存在')
    record.status = 'indexing'
    record.error = undefined
    await this.persist()
    try {
      const counts = new Map<ProcessLibraryFileKind, { count: number; examples: string[] }>()
      const libertyCandidates: string[] = []
      let fileCount = 0
      const walk = async (dir: string): Promise<void> => {
        if (fileCount >= MAX_INDEX_FILES) return
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue
          const full = join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else {
            fileCount += 1
            const kind = KIND_BY_EXT[extname(entry.name).toLowerCase()] ?? 'other'
            if (kind === 'liberty') libertyCandidates.push(full)
            const group = counts.get(kind) ?? { count: 0, examples: [] }
            group.count += 1
            if (group.examples.length < 5) group.examples.push(relative(record.path, full).replace(/\\/g, '/'))
            counts.set(kind, group)
          }
          if (fileCount >= MAX_INDEX_FILES) break
        }
      }
      await walk(record.path)
      record.fileCount = fileCount
      record.files = [...counts.entries()].map(([kind, value]) => ({ kind, ...value })).sort((a, b) => b.count - a.count)
      record.defaultLibertyPath = libertyCandidates.sort((a, b) => {
        const score = (value: string): number => /NangateOpenCellLibrary_typical\.lib$/i.test(value) ? 0 : /typical/i.test(value) ? 1 : 2
        return score(a) - score(b) || a.localeCompare(b)
      })[0]
      record.indexedAt = new Date().toISOString()
      record.status = 'ready'
    } catch (error) {
      record.status = existsSync(record.path) ? 'error' : 'missing'
      record.error = error instanceof Error ? error.message : String(error)
    }
    await this.persist()
    return { ...record }
  }

  async remove(id: string): Promise<boolean> {
    const before = this.records.length
    this.records = this.records.filter((record) => record.id !== id)
    await this.persist()
    return this.records.length < before
  }

  get(id: string): ProcessLibraryRecord | undefined { return this.records.find((record) => record.id === id) }
  getIndexPath(): string { return this.indexPath }

  private async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const defaultLiberty = this.records.find((record) => record.catalogId === 'nangate45' && record.defaultLibertyPath)?.defaultLibertyPath
      ?? this.records.find((record) => record.defaultLibertyPath)?.defaultLibertyPath
    if (defaultLiberty && existsSync(defaultLiberty)) process.env.MOONGLASS_DEFAULT_LIBERTY = defaultLiberty
    else delete process.env.MOONGLASS_DEFAULT_LIBERTY
    await writeFile(this.storePath, JSON.stringify(this.records, null, 2), 'utf-8')
    await writeFile(this.indexPath, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), defaultLiberty: defaultLiberty ?? null, libraries: this.records }, null, 2), 'utf-8')
  }

  private runGit(args: string[]): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', args, { windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000) })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`Git 下载失败 (code=${code}): ${stderr.trim()}`)))
    })
  }
}
