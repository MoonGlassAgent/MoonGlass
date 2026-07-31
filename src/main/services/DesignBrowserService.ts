import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { elaborateDesign, type DesignDatabase } from '@moonglass/design-browser-engine'
import type { MoonGlassService } from '../core/lifecycle'

export interface TopModuleCandidate {
  name: string
  file: string
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
    return collectRtl(join(workspaceDir, 'rtl')).flatMap((file) => {
      const content = readFileSync(file, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      return [...content.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/g)].map((match) => ({
        name: match[1],
        file: relative(workspaceDir, file)
      }))
    })
  }

  async elaborate(projectId: string, workspaceDir: string, topModule: string): Promise<DesignDatabase> {
    const rtlFiles = collectRtl(join(workspaceDir, 'rtl'))
    const projectCache = join(this.cacheRoot, projectId)
    mkdirSync(projectCache, { recursive: true })
    const rawJson = join(projectCache, `${topModule}.yosys.json`)
    const database = await elaborateDesign({ rtlFiles, topModule, outputJson: rawJson })
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
    const match = /^(.*?):(\d+)(?:\.\d+)?(?:-\d+(?:\.\d+)?)?$/.exec(source)
    const sourcePath = match?.[1] ?? source
    const line = Number(match?.[2] ?? 1)
    const absolute = resolve(sourcePath)
    const workspace = resolve(workspaceDir)
    if (absolute !== workspace && !absolute.startsWith(`${workspace}\\`) && !absolute.startsWith(`${workspace}/`)) {
      throw new Error('源码路径越出项目工作区')
    }
    if (!existsSync(absolute)) throw new Error(`源码文件不存在: ${sourcePath}`)
    return { file: relative(workspace, absolute), line, content: readFileSync(absolute, 'utf-8') }
  }
}
