import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { PHASE_ORDER, type Phase, type ProjectImportAssessment } from '../../shared/types/moonglass.ts'

const MAX_FILES = 12_000
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '__pycache__', '.cache', '.venv', 'venv'])
const HDL_EXTENSIONS = new Set(['.v', '.sv', '.vh', '.svh', '.vhd', '.vhdl'])

interface EvidenceBucket {
  score: number
  paths: string[]
}

function add(bucket: EvidenceBucket, score: number, path: string): void {
  bucket.score += score
  if (bucket.paths.length < 8 && !bucket.paths.includes(path)) bucket.paths.push(path)
}

export function analyzeExistingProject(directory: string): ProjectImportAssessment {
  const root = resolve(directory)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('项目目录不存在或不是目录')
  const buckets = Object.fromEntries(PHASE_ORDER.map((phase) => [phase, { score: 0, paths: [] }])) as Record<Phase, EvidenceBucket>
  let fileCount = 0
  let truncated = false

  const walk = (dir: string): void => {
    if (truncated) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (fileCount >= MAX_FILES) { truncated = true; return }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      fileCount += 1
      const full = join(dir, entry.name)
      const rel = relative(root, full).replace(/\\/g, '/')
      const lower = rel.toLowerCase()
      const name = entry.name.toLowerCase()
      const ext = extname(name)

      if (/requirement|requirements|specification|(^|[/_.-])spec([/_.-]|$)|srs|prd|需求|规格/.test(lower)) add(buckets.REQ_SPEC, 2, rel)
      if (/trace|matrix|rtm|追踪|追溯/.test(lower)) add(buckets.REQ_SPEC, 2, rel)
      if (/architect|microarch|block.?diagram|interface|register.?map|clock|reset|架构|接口|寄存器/.test(lower)) add(buckets.ARCH, 2, rel)

      const looksTest = /(^|[/_.-])(tb|testbench|test|tests|verification|verify|uvm|cocotb|sim)([/_.-]|$)/.test(lower)
      if (HDL_EXTENSIONS.has(ext) && !looksTest) add(buckets.RTL, 1, rel)
      if (looksTest && (HDL_EXTENSIONS.has(ext) || ['.py', '.cpp', '.c'].includes(ext))) add(buckets.VERIF, 2, rel)
      if (/coverage|results?\.xml|junit|regression|simulation\.log|compile\.log/.test(lower)) add(buckets.VERIF, 2, rel)
      if (['.vcd', '.fst', '.wlf', '.fsdb'].includes(ext)) add(buckets.VERIF, 3, rel)

      if (/lint|cdc|rdc|review|checklist|quality|signoff|质量|审查/.test(lower) && ['.log', '.rpt', '.txt', '.md', '.json', '.xml'].includes(ext)) add(buckets.QA, 2, rel)
      if (ext === '.sdc') add(buckets.SYNTH, 2, rel)
      if (/synth|timing|area|sta|netlist|mapped|gate/.test(lower) && ['.log', '.rpt', '.txt', '.json', '.v', '.sv'].includes(ext)) add(buckets.SYNTH, 2, rel)
    }
  }
  walk(root)

  const thresholds: Record<Phase, number> = { REQ_SPEC: 1, ARCH: 2, RTL: 2, VERIF: 2, QA: 2, SYNTH: 2 }
  let suggestedPhase: Phase = 'REQ_SPEC'
  for (const phase of PHASE_ORDER) {
    if (buckets[phase].score >= thresholds[phase]) suggestedPhase = phase
  }
  const score = buckets[suggestedPhase].score
  const confidence = Math.max(35, Math.min(95, 45 + score * 8 - (truncated ? 10 : 0)))
  const warnings: string[] = []
  if (fileCount === 0) warnings.push('目录为空，将按全新项目初始化。')
  if (truncated) warnings.push(`文件超过 ${MAX_FILES} 个，阶段判断基于前 ${MAX_FILES} 个文件。`)
  if (fileCount > 0 && buckets.REQ_SPEC.paths.length === 0) warnings.push('未识别到需求/规格或追踪矩阵，导入后需建立 MoonGlass 追溯映射。')
  if (suggestedPhase === 'RTL' && buckets.ARCH.paths.length === 0) warnings.push('识别到 RTL，但未找到明确架构文档；不会因此降级为全新项目。')

  return {
    isExistingProject: fileCount > 0,
    suggestedPhase,
    confidence,
    fileCount,
    truncated,
    evidence: Object.fromEntries(PHASE_ORDER.map((phase) => [phase, {
      score: buckets[phase].score,
      paths: buckets[phase].paths
    }])) as ProjectImportAssessment['evidence'],
    warnings
  }
}
