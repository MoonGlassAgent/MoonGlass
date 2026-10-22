import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const EXCLUDED_DIRS = /^(obj_dir|__pycache__|node_modules|build|sim_build|04_verification)$/i
const EXCLUDED_FILES = /^(_+)?(synth_|output_|result_|merged_|combined_|tmp_|temp_)/i
// macros/ 也可以包含设计侧 wrapper；只排除明确命名的互斥宏视图。
const MACRO_VIEW = /_(?:behavioral|blackbox|phy_template)\.v$/i

/** 判官函数：是否为互斥宏视图（behavioral/blackbox/phy_template 命名后缀） */
export function isMacroViewFile(file: string): boolean {
  return MACRO_VIEW.test(file)
}

export interface RtlInputSet {
  designFiles: string[]
  simulationFiles: string[]
  libraryFiles: string[]
  physicalFiles: string[]
  topModule?: string
  includeDirs: string[]
  defines: string[]
  manifestPath?: string
}

export function collectRtlFiles(dir: string): string[] {
  const out: string[] = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || EXCLUDED_DIRS.test(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectRtlFiles(full))
    else if (/\.(v|sv)$/i.test(entry.name) && !EXCLUDED_FILES.test(entry.name)) out.push(full)
  }
  return out
}

function resolveEntry(workspaceDir: string, rtlDir: string, entry: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(entry)) return resolve(entry)
  return resolve(entry.replace(/\\/g, '/').startsWith('rtl/') ? workspaceDir : rtlDir, entry)
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function readRtlInputs(workspaceDir: string): RtlInputSet {
  const rtlDir = resolve(workspaceDir, 'rtl')
  const manifestPath = join(rtlDir, 'design.json')
  if (!existsSync(manifestPath)) {
    return { designFiles: collectRtlFiles(rtlDir).filter((file) => !MACRO_VIEW.test(file)), simulationFiles: [], libraryFiles: [], physicalFiles: [], includeDirs: [], defines: [] }
  }
  let data: Record<string, unknown>
  try { data = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown> } catch {
    return { designFiles: collectRtlFiles(rtlDir).filter((file) => !MACRO_VIEW.test(file)), simulationFiles: [], libraryFiles: [], physicalFiles: [], includeDirs: [], defines: [], manifestPath }
  }
  let designEntries = list(data.files)
  const filelistPath = resolveEntry(workspaceDir, rtlDir, typeof data.filelist === 'string' ? data.filelist : 'filelist.f')
  if (designEntries.length === 0 && existsSync(filelistPath)) {
    designEntries = readFileSync(filelistPath, 'utf-8').split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, '').replace(/#.*$/, '').trim())
      .filter((line) => line.length > 0 && !/^[+-]/.test(line))
  }
  const unique = (items: string[]): string[] => [...new Set(items.map((item) => resolveEntry(workspaceDir, rtlDir, item)))]
  return {
    designFiles: designEntries.length > 0 ? unique(designEntries).filter((file) => !MACRO_VIEW.test(file)) : collectRtlFiles(rtlDir).filter((file) => !MACRO_VIEW.test(file)),
    simulationFiles: unique(list(data.simulationFiles)),
    libraryFiles: unique(list(data.libraryFiles)),
    physicalFiles: unique(list(data.physicalFiles)),
    topModule: typeof data.topModule === 'string' && data.topModule.trim() ? data.topModule.trim() : undefined,
    includeDirs: unique(list(data.includeDirs)),
    defines: list(data.defines),
    manifestPath
  }
}
