import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { buildDatabaseV3, elaborateDesign, type DesignDatabase } from '@moonglass/design-browser-engine'
import { hashRtlInputs, isMacroViewFile, readRtlInputs, readSlangAst, runSlangAst } from '@moonglass/eda-bridge'
import type { MoonGlassService } from '../core/lifecycle'

export interface TopModuleCandidate {
  name: string
  file: string
  recommended: boolean
  reason: 'manifest' | 'root-module' | 'candidate'
}

export interface DesignSourceContent {
  file: string
  line: number
  content: string
}

/** getCached 返回形状：缓存数据库 + RTL 输入是否已变更（true = 建议重新解析） */
export interface CachedDesign {
  database: DesignDatabase
  rtlStale: boolean
}

interface DesignManifest {
  topModule?: string
  filelist?: string | string[]
  /** 综合视图优先，避免 Design Browser 展开 SRAM 等行为模型。 */
  filelistSyn?: string | string[]
  files?: string[]
  /** SRAM 等宏的 blackbox 视图（read_verilog -lib 用），用于解析宏实例化。 */
  libraryFiles?: string | string[]
  /** 仿真专用文件（TB、行为模型等），不属于设计综合视图。 */
  simulationFiles?: string | string[]
  includeDirs?: string[]
  defines?: string[]
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readManifest(rtlDir: string): DesignManifest {
  const path = join(rtlDir, 'design.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DesignManifest
  } catch {
    return {}
  }
}

function resolveDesignPath(workspaceDir: string, rtlDir: string, value: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) return resolve(value)
  const normalized = value.replaceAll('\\', '/')
  return normalized.startsWith('rtl/')
    ? resolve(workspaceDir, normalized)
    : resolve(rtlDir, normalized)
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flat(Infinity).filter((item): item is string => typeof item === 'string')
  return []
}

function parseFilelist(workspaceDir: string, rtlDir: string, manifest: DesignManifest): {
  files: string[]
  /** 宏 blackbox 视图：slang 以 -v 库方式按需搜索；Yosys 路径作为普通可读文件追加 */
  libraries: string[]
  includeDirs: string[]
  defines: string[]
} {
  const preferredFilelist = manifest.filelistSyn ?? manifest.filelist
  const manifestFiles = Array.isArray(preferredFilelist)
    ? stringList(preferredFilelist)
    : stringList(manifest.files)
  const includeDirs = stringList(manifest.includeDirs)
    .map((dir) => resolveDesignPath(workspaceDir, rtlDir, dir))
  const defines = stringList(manifest.defines)
  // 宏 blackbox 视图：用于解析 SRAM 等宏的实例化，不展开行为阵列
  const libraries = stringList(manifest.libraryFiles)
    .map((file) => resolveDesignPath(workspaceDir, rtlDir, file))

  let files: string[]
  if (manifestFiles.length > 0) {
    files = manifestFiles.map((file) => resolveDesignPath(workspaceDir, rtlDir, file))
  } else {
    const filelistName = typeof preferredFilelist === 'string' ? preferredFilelist : 'filelist.f'
    const filelistPath = resolveDesignPath(workspaceDir, rtlDir, filelistName)
    if (!existsSync(filelistPath)) {
      files = readRtlInputs(workspaceDir).designFiles
    } else {
      files = []
      for (const sourceLine of readFileSync(filelistPath, 'utf-8').split(/\r?\n/)) {
        const line = sourceLine.replace(/\/\/.*$/, '').replace(/#.*$/, '').trim()
        if (!line) continue
        if (line.startsWith('+incdir+')) includeDirs.push(resolveDesignPath(workspaceDir, rtlDir, line.slice(8)))
        else if (line.startsWith('+define+')) defines.push(line.slice(8))
        else if (!line.startsWith('+')) files.push(resolveDesignPath(workspaceDir, rtlDir, line))
      }
      if (files.length === 0) files = readRtlInputs(workspaceDir).designFiles
    }
  }
  return { files, libraries, includeDirs, defines }
}

export class DesignBrowserService implements MoonGlassService {
  readonly name = 'design-browser-service'
  private readonly cacheRoot: string
  /** slang AST 缓存（<dataDir>/moonglass/slang-ast-cache，与 verification 引擎共享口径） */
  private readonly slangAstCacheDir: string
  private readonly memory = new Map<string, DesignDatabase>()

  constructor(dataDir: string) {
    this.cacheRoot = join(dataDir, 'moonglass', 'design-browser-cache')
    this.slangAstCacheDir = join(dataDir, 'moonglass', 'slang-ast-cache')
  }

  start(): void {
    mkdirSync(this.cacheRoot, { recursive: true })
  }

  stop(): void {
    this.memory.clear()
  }

  listTopModules(workspaceDir: string): TopModuleCandidate[] {
    const rtlDir = join(workspaceDir, 'rtl')
    const manifest = readManifest(rtlDir)
    // 与 elaborate 同一输入口径（filelistSyn ?? filelist ?? files + filelist 回退），
    // 并显式排除库 blackbox 视图、仿真文件与互斥宏视图，避免污染根模块判定
    const inputs = parseFilelist(workspaceDir, rtlDir, manifest)
    const excluded = new Set([
      ...stringList(manifest.libraryFiles).map((file) => resolveDesignPath(workspaceDir, rtlDir, file)),
      ...stringList(manifest.simulationFiles).map((file) => resolveDesignPath(workspaceDir, rtlDir, file))
    ])
    const sources = inputs.files
      .filter((file) => !excluded.has(file) && !isMacroViewFile(file))
      .map((file) => {
        const content = readFileSync(file, 'utf-8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
        return { file, content }
      })
    const modules = sources.flatMap(({ file, content }) =>
      [...content.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/g)].map((match) => ({
        name: match[1],
        file: relative(workspaceDir, file)
      }))
    )
    const names = new Set(modules.map((module) => module.name))
    const instantiated = new Set<string>()
    if (names.size > 0) {
      const moduleAlternation = [...names]
        .sort((a, b) => b.length - a.length)
        .map(regexEscape)
        .join('|')
      const instancePattern = new RegExp(
        `\\b(${moduleAlternation})\\b\\s*(?:#\\s*\\([\\s\\S]{0,500}?\\)\\s*)?[A-Za-z_][A-Za-z0-9_$]*\\s*\\(`,
        'g'
      )
      for (const source of sources) {
        instancePattern.lastIndex = 0
        for (const match of source.content.matchAll(instancePattern)) instantiated.add(match[1])
      }
    }
    const roots = new Set(modules.filter((module) => !instantiated.has(module.name)).map((module) => module.name))
    const unique = [...new Map(modules.map((module) => [module.name, module])).values()]
    return unique
      .map((module) => ({
        name: module.name,
        file: module.file,
        recommended: manifest.topModule === module.name || (!manifest.topModule && roots.size === 1 && roots.has(module.name)),
        reason: manifest.topModule === module.name
          ? 'manifest' as const
          : roots.has(module.name)
            ? 'root-module' as const
            : 'candidate' as const
      }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name))
  }

  async elaborate(projectId: string, workspaceDir: string, topModule: string): Promise<DesignDatabase> {
    const rtlDir = join(workspaceDir, 'rtl')
    const manifest = readManifest(rtlDir)
    const inputs = parseFilelist(workspaceDir, rtlDir, manifest)
    const projectCache = join(this.cacheRoot, projectId)
    mkdirSync(projectCache, { recursive: true })
    const rtlFiles = [...inputs.files, ...inputs.libraries]
    const rtlHash = hashRtlInputs(rtlFiles)
    // v3（slang 前端，RTL 级数据模型）：AST 按 rtlHash 缓存；任何不可用情形回退 Yosys v2
    try {
      const outcome = runSlangAst({
        workspace: workspaceDir,
        files: inputs.files,
        cacheDir: this.slangAstCacheDir,
        rtlHash,
        libraryFiles: inputs.libraries,
        includeDirs: inputs.includeDirs,
        defines: inputs.defines,
        topModule
      })
      if (outcome.status === 'ok') {
        const database = buildDatabaseV3({ ast: readSlangAst(outcome.astPath), workspace: workspaceDir, rtlFiles, topModule })
        return this.persist(projectId, projectCache, topModule, { ...database, rtlInputHash: rtlHash })
      }
      const reason = outcome.status === 'missing'
        ? '未找到 slang（SystemVerilog 编译器）'
        : outcome.status === 'oversize'
          ? `AST ${outcome.sizeMB}MB 超过 128MB 消费上限`
          : outcome.log
      return await this.elaborateV2Fallback(projectId, projectCache, topModule, rtlFiles, inputs, rtlHash, reason)
    } catch (error) {
      return await this.elaborateV2Fallback(projectId, projectCache, topModule, rtlFiles, inputs, rtlHash, error instanceof Error ? error.message : String(error))
    }
  }

  private persist(projectId: string, projectCache: string, topModule: string, stamped: DesignDatabase): DesignDatabase {
    writeFileSync(join(projectCache, `${topModule}.design.json`), JSON.stringify(stamped), 'utf-8')
    this.memory.set(projectId, stamped)
    return stamped
  }

  /** v2 回退（Yosys 管线，冻结形态）：diagnostics 显式登记降级原因，rtlInputHash 与 v3 同口径 */
  private async elaborateV2Fallback(
    projectId: string,
    projectCache: string,
    topModule: string,
    rtlFiles: string[],
    inputs: { libraries: string[]; includeDirs: string[]; defines: string[] },
    rtlHash: string,
    reason: string
  ): Promise<DesignDatabase> {
    const database = await elaborateDesign({
      rtlFiles,
      topModule,
      outputJson: join(projectCache, `${topModule}.yosys.json`),
      includeDirs: inputs.includeDirs,
      defines: inputs.defines
    })
    const stamped: DesignDatabase = {
      ...database,
      rtlInputHash: rtlHash,
      diagnostics: [
        ...database.diagnostics,
        { severity: 'warning', message: `Design Browser v3 slang 前端不可用（${reason}），已回退 Yosys v2（trace 为单元级粒度，信号名经 Yosys 优化改写）` }
      ]
    }
    return this.persist(projectId, projectCache, topModule, stamped)
  }

  /** 重算当前 RTL 输入哈希并与缓存标记比对；缓存无标记或哈希计算失败一律按已变更处理 */
  private rtlStaleOf(workspaceDir: string, database: DesignDatabase): boolean {
    if (!database.rtlInputHash) return true
    try {
      const rtlDir = join(workspaceDir, 'rtl')
      const inputs = parseFilelist(workspaceDir, rtlDir, readManifest(rtlDir))
      return hashRtlInputs([...inputs.files, ...inputs.libraries]) !== database.rtlInputHash
    } catch {
      return true
    }
  }

  getCached(projectId: string, workspaceDir: string): CachedDesign | null {
    const current = this.memory.get(projectId)
    // v3 起 getCached 仅接受 slang 数据库；v2（Yosys 回退）一律判过期重新 elaborate
    if (current) {
      if (current.version !== 3) return null
      return { database: current, rtlStale: this.rtlStaleOf(workspaceDir, current) }
    }
    const projectCache = join(this.cacheRoot, projectId)
    if (!existsSync(projectCache)) return null
    const latest = readdirSync(projectCache)
      .filter((name) => name.endsWith('.design.json'))
      .map((name) => join(projectCache, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    if (!latest) return null
    try {
      const database = JSON.parse(readFileSync(latest, 'utf-8')) as DesignDatabase
      // v3 起 getCached 仅接受 slang 数据库；v2（Yosys 回退）缓存一律判过期重新 elaborate
      if (database.version !== 3) return null
      this.memory.set(projectId, database)
      return { database, rtlStale: this.rtlStaleOf(workspaceDir, database) }
    } catch {
      return null
    }
  }

  readSource(workspaceDir: string, source: string): DesignSourceContent {
    const workspace = resolve(workspaceDir)
    // v3 source 为「工作区相对路径:行号」；v2 为绝对路径——统一基于工作区解析
    const candidates = source.split('|').map((item) => item.trim()).filter(Boolean)
    const missing: string[] = []
    for (const candidate of candidates) {
      const match = /^(.*?):(\d+)(?:\.\d+)?(?:-\d+(?:\.\d+)?)?$/.exec(candidate)
      const sourcePath = match?.[1] ?? candidate
      const line = Number(match?.[2] ?? 1)
      const absolute = resolve(workspace, sourcePath)
      if (absolute !== workspace && !absolute.startsWith(`${workspace}\\`) && !absolute.startsWith(`${workspace}/`)) {
        continue
      }
      if (!existsSync(absolute)) {
        missing.push(sourcePath)
        continue
      }
      return { file: relative(workspace, absolute), line, content: readFileSync(absolute, 'utf-8') }
    }
    if (missing.length > 0) throw new Error(`源码文件不存在: ${missing.join('、')}`)
    throw new Error(`没有可读取的项目内源码位置: ${source}`)
  }
}
