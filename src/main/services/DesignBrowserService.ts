import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { elaborateDesign, type DesignDatabase } from '@moonglass/design-browser-engine'
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

function collectRtl(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectRtl(full))
    else if (/\.(v|sv)$/i.test(entry.name)) out.push(full)
  }
  return out
}

interface DesignManifest {
  topModule?: string
  filelist?: string | string[]
  files?: string[]
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
  includeDirs: string[]
  defines: string[]
} {
  const manifestFiles = Array.isArray(manifest.filelist)
    ? stringList(manifest.filelist)
    : stringList(manifest.files)
  const includeDirs = stringList(manifest.includeDirs)
    .map((dir) => resolveDesignPath(workspaceDir, rtlDir, dir))
  const defines = stringList(manifest.defines)
  if (manifestFiles.length > 0) {
    return {
      files: manifestFiles.map((file) => resolveDesignPath(workspaceDir, rtlDir, file)),
      includeDirs,
      defines
    }
  }

  const filelistName = typeof manifest.filelist === 'string' ? manifest.filelist : 'filelist.f'
  const filelistPath = resolveDesignPath(workspaceDir, rtlDir, filelistName)
  if (!existsSync(filelistPath)) {
    return {
      files: collectRtl(rtlDir),
      includeDirs,
      defines
    }
  }
  const files: string[] = []
  for (const sourceLine of readFileSync(filelistPath, 'utf-8').split(/\r?\n/)) {
    const line = sourceLine.replace(/\/\/.*$/, '').replace(/#.*$/, '').trim()
    if (!line) continue
    if (line.startsWith('+incdir+')) includeDirs.push(resolveDesignPath(workspaceDir, rtlDir, line.slice(8)))
    else if (line.startsWith('+define+')) defines.push(line.slice(8))
    else if (!line.startsWith('+')) files.push(resolveDesignPath(workspaceDir, rtlDir, line))
  }
  return { files: files.length > 0 ? files : collectRtl(rtlDir), includeDirs, defines }
}

export class DesignBrowserService implements MoonGlassService {
  readonly name = 'design-browser-service'
  private readonly cacheRoot: string
  private readonly memory = new Map<string, DesignDatabase>()

  constructor(dataDir: string) {
    this.cacheRoot = join(dataDir, 'moonglass', 'design-browser-cache')
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
    const modules = collectRtl(rtlDir).flatMap((file) => {
      const content = readFileSync(file, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      return [...content.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/g)].map((match) => ({
        name: match[1],
        file: relative(workspaceDir, file),
        content
      }))
    })
    const names = new Set(modules.map((module) => module.name))
    const instantiated = new Set<string>()
    for (const owner of modules) {
      for (const name of names) {
        if (name === owner.name) continue
        const instancePattern = new RegExp(
          `\\b${regexEscape(name)}\\b\\s*(?:#\\s*\\([\\s\\S]{0,500}?\\)\\s*)?[A-Za-z_][A-Za-z0-9_$]*\\s*\\(`
        )
        if (instancePattern.test(owner.content)) instantiated.add(name)
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
    const rawJson = join(projectCache, `${topModule}.yosys.json`)
    const database = await elaborateDesign({
      rtlFiles: inputs.files,
      topModule,
      outputJson: rawJson,
      includeDirs: inputs.includeDirs,
      defines: inputs.defines
    })
    writeFileSync(join(projectCache, `${topModule}.design.json`), JSON.stringify(database), 'utf-8')
    this.memory.set(projectId, database)
    return database
  }

  getCached(projectId: string): DesignDatabase | null {
    const current = this.memory.get(projectId)
    if (current) return current
    const projectCache = join(this.cacheRoot, projectId)
    if (!existsSync(projectCache)) return null
    const latest = readdirSync(projectCache)
      .filter((name) => name.endsWith('.design.json'))
      .map((name) => join(projectCache, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    if (!latest) return null
    try {
      const database = JSON.parse(readFileSync(latest, 'utf-8')) as DesignDatabase
      this.memory.set(projectId, database)
      return database
    } catch {
      return null
    }
  }

  readSource(workspaceDir: string, source: string): DesignSourceContent {
    const workspace = resolve(workspaceDir)
    const candidates = source.split('|').map((item) => item.trim()).filter(Boolean)
    const missing: string[] = []
    for (const candidate of candidates) {
      const match = /^(.*?):(\d+)(?:\.\d+)?(?:-\d+(?:\.\d+)?)?$/.exec(candidate)
      const sourcePath = match?.[1] ?? candidate
      const line = Number(match?.[2] ?? 1)
      const absolute = resolve(sourcePath)
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
