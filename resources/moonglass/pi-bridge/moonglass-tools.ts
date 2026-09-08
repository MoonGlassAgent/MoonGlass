/**
 * MoonGlass 芯片专用工具集（Pi 扩展）
 *
 * 以 Pi Coding Agent 扩展形式注册芯片 EDA 工具，让 Agent 可在对话中
 * 调用 lint 检查、可综合性检查、仿真运行等芯片专用能力。
 *
 * 加载方式：AgentService spawn pi 时通过 `-e` 加载本文件。
 * 本文件复制到 userData/moonglass/pi-bridge/ 后由 pi 的 jiti 加载。
 * 共享的 EDA 工具执行层与 Verilator 仿真实现来自同目录下的 `eda-bridge/`，
 * 由 AgentService 启动时从 packages/eda-bridge/src/ 复制过来。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  locateTool,
  run,
  runWithFallback,
  toolEnv,
  VERILATOR_CANDIDATES,
  YOSYS_CANDIDATES
} from './eda-bridge/tool-runner'
import { runCocotbSimulation, runVerilatorSimulation } from './eda-bridge/simulation'
import { generateSdc, runLogicSynthesis } from './eda-bridge/synthesis'
import { runFormalVerification } from './eda-bridge/formal'
import { runDesignLint } from './eda-bridge/lint'
import { collectRtlFiles, readRtlInputs } from './eda-bridge/rtl-files'
import { buildVerificationIntelligence, recordExplorationRound, registerVerificationHypotheses, reviewScenarioClosure, refineVerificationIntents, recordScenarioAdjudication, registerVerificationIntents, recordRootCause, computeRtlHash } from './verification-intelligence/engine.ts'

type DiagnosticLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5'

interface DiagnosticAttempt {
  id: string
  topModule: string
  testcase: string
  passed: boolean
  createdAt: string
  durationMs: number
  failureSignature: string
  rtlHash: string
  testbenchHash: string
  diagnosticLevel: DiagnosticLevel
  observations: string[]
  evidence: string[]
}

interface DiagnosticControlState {
  version: 1
  updatedAt: string
  mode: 'NORMAL_DEBUG' | 'DIAGNOSTIC_ENHANCEMENT' | 'CLOSED'
  activeCase: string
  attempts: DiagnosticAttempt[]
  recommendation: string
}

function walkFiles(dir: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() && !['__pycache__', 'sim_build', 'obj_dir'].includes(entry.name)) files.push(...walkFiles(full, accept))
    else if (entry.isFile() && accept(full)) files.push(full)
  }
  return files.sort()
}

function filesHash(files: string[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    if (!existsSync(file)) continue
    try { hash.update(file).update('\0').update(readFileSync(file)).update('\0') } catch { /* 文件并发变化由下一次尝试记录 */ }
  }
  return hash.digest('hex')
}

function failureSignature(log: string): string {
  const normalized = log.split(/\r?\n/)
    .map((line) => line.replace(/[A-Z]:\\[^\s:]+/gi, '<path>').replace(/\b\d+(?:\.\d+)?\s*(?:ns|us|ms|s|cycles?)\b/gi, '<time>').replace(/\b0x[0-9a-f]+\b/gi, '<hex>').replace(/\b\d{4,}\b/g, '<number>').trim())
    .filter((line) => /error|fail|assert|mismatch|timeout|traceback|exception|fatal/i.test(line))
    .slice(-12)
    .join('\n') || log.slice(-1200)
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
}

function inferDiagnosticLevel(log: string, hasWaveform: boolean): { level: DiagnosticLevel; observations: string[] } {
  const observations: string[] = []
  let rank = 0
  if (/test(?:case)?|@cocotb\.test|FAILED/i.test(log)) { rank = 0; observations.push('已定位失败用例或最终失败') }
  if (/channel|transaction|request|response|interface|axi|apb|ahb|fifo/i.test(log)) { rank = Math.max(rank, 1); observations.push('已缩小到接口、通道或事务范围') }
  if (/\b(?:cycle|time|timestamp|\d+\s*(?:ns|us|ms))\b/i.test(log) || hasWaveform) { rank = Math.max(rank, 2); observations.push('已有时间窗口或波形证据') }
  if (/state|counter|count|outstanding|queue|pointer|occupancy|register/i.test(log)) { rank = Math.max(rank, 3); observations.push('已关联状态、计数器或队列对象') }
  if (/root cause|duplicate|underflow|overflow|priority|dropped|stale|race/i.test(log)) { rank = Math.max(rank, 4); observations.push('已有具体根因候选') }
  if (/formal.*(?:trace|counterexample)|assertion.*(?:proves|confirmed)|root cause confirmed/i.test(log)) { rank = 5; observations.push('已有反例、Assertion 或等价强证据确认根因') }
  return { level: `L${rank}` as DiagnosticLevel, observations }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(temporary, path)
}

async function validatePythonTests(testDir: string, signal?: AbortSignal): Promise<{ ok: boolean; issues: string[] }> {
  const files = walkFiles(testDir, (path) => path.endsWith('.py'))
  const issues: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf-8')
    const markers = [...source.matchAll(/MOONGLASS-BEGIN:([A-Za-z0-9_.-]+)/g)].map((match) => match[1])
    for (const marker of new Set(markers)) if (markers.filter((item) => item === marker).length > 1) issues.push(`${relative(testDir, file)}：重复注入标记 ${marker}`)
    const functions = [...source.matchAll(/^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/gm)].map((match) => match[1])
    for (const name of new Set(functions)) if (functions.filter((item) => item === name).length > 1) issues.push(`${relative(testDir, file)}：重复测试函数 ${name}`)
  }
  const python = await locateTool(process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python'])
  if (!python) issues.push('未找到 Python，无法执行测试文件语法预检')
  else for (const file of files) {
    const result = await run(python, ['-m', 'py_compile', file], toolEnv(python), signal, testDir, 30_000)
    if (result.code !== 0) issues.push(`${relative(testDir, file)}：${(result.stderr || result.stdout).trim()}`)
  }
  return { ok: issues.length === 0, issues }
}

function updateDiagnosticControl(input: {
  workspace: string; topModule: string; testcase?: string; passed: boolean; log: string
  rtlFiles: string[]; testDir?: string; evidence: string[]; hasWaveform: boolean; durationMs: number
}): DiagnosticControlState {
  const path = join(input.workspace, 'verification', 'results', 'diagnostic-control.json')
  let previous: DiagnosticControlState | undefined
  try { previous = JSON.parse(readFileSync(path, 'utf-8')) as DiagnosticControlState } catch { /* 首次执行 */ }
  const activeCase = `${input.topModule}::${input.testcase ?? 'all'}`
  const diagnosis = inferDiagnosticLevel(input.log, input.hasWaveform)
  const attempt: DiagnosticAttempt = {
    id: `ATT-${Date.now()}`, topModule: input.topModule, testcase: input.testcase ?? 'all', passed: input.passed,
    createdAt: new Date().toISOString(), durationMs: input.durationMs, failureSignature: input.passed ? 'PASS' : failureSignature(input.log),
    rtlHash: filesHash(input.rtlFiles), testbenchHash: input.testDir ? filesHash(walkFiles(input.testDir, (file) => /\.(?:py|sv|v|cpp|json)$/i.test(file))) : '',
    diagnosticLevel: diagnosis.level, observations: diagnosis.observations, evidence: input.evidence.filter(Boolean)
  }
  const attempts = [...(previous?.attempts ?? []), attempt].slice(-40)
  const related = attempts.filter((item) => `${item.topModule}::${item.testcase}` === activeCase)
  const sameFailure = related.filter((item) => !item.passed && item.failureSignature === attempt.failureSignature)
  const maxEarlierLevel = Math.max(-1, ...related.slice(0, -1).map((item) => Number(item.diagnosticLevel.slice(1))))
  const noDiagnosticProgress = !input.passed && Number(attempt.diagnosticLevel.slice(1)) <= maxEarlierLevel
  const repeated = !input.passed && (sameFailure.length >= 2 || (related.length >= 3 && noDiagnosticProgress))
  const mode: DiagnosticControlState['mode'] = input.passed ? 'CLOSED' : repeated ? 'DIAGNOSTIC_ENHANCEMENT' : 'NORMAL_DEBUG'
  const recommendation = input.passed
    ? '当前用例已通过；继续运行受影响回归并保留闭环证据。'
    : repeated
      ? '检测到重复失败且诊断信息没有明显收敛。暂停继续盲改 RTL；先增强阶段性 Checker、协议/状态 Assertion、事务标识、Scoreboard 队列输出和必要波形，定位首个偏差点。不得修改正确预期来迎合 RTL。'
      : '固定失败用例与 seed，提出单一根因假设并做最小修改；若下一轮仍失败，应优先增强诊断证据。'
  const state: DiagnosticControlState = { version: 1, updatedAt: new Date().toISOString(), mode, activeCase, attempts, recommendation }
  writeJsonAtomic(path, state)
  return state
}

export interface ScenarioHitWriteInput {
  /** 显式场景 ID（来自 select_next_verification_batch 返回的批次），优先于 testcase 名解析 */
  scenarioIds?: string[]
  /** 用例名；含 scn_<8位hex> 标记时可解析出场景 ID */
  testcase?: string
  passed: boolean
  rtlFiles: string[]
  evidence: string[]
}

export interface ScenarioHitWriteResult {
  registered: string[]
  warnings: string[]
}

/**
 * 把仿真执行结果自动登记到 verification/results/<topModule>/scenario_hits.json（合并写）。
 * 这是 scenario_hits.json 的唯一写入入口：PASS/FAIL 都登记（失败同样是证据），
 * Agent 禁止手写该文件。导出以便 smoke 直接测试合并逻辑。
 * rtlHash 必须使用引擎统一口径（computeRtlHash，与新鲜度判定同一哈希空间）；
 * 引擎不可用时回退 filesHash 并在 warnings 中说明（该回退的哈希不参与新鲜度判定）。
 */
export function writeScenarioHits(workspace: string, topModule: string, input: ScenarioHitWriteInput): ScenarioHitWriteResult {
  const warnings: string[] = []
  const explicit = [...new Set((input.scenarioIds ?? []).map((id) => id.toUpperCase()))]
  const parsed = [...new Set([...(input.testcase ?? '').matchAll(/scn_([0-9a-fA-F]{8})/g)].map((match) => `SCN-${match[1].toUpperCase()}`))]
  if (explicit.length && parsed.length && (explicit.length !== parsed.length || explicit.some((id) => !parsed.includes(id)))) {
    warnings.push(`显式 scenarioIds（${explicit.join('、')}）与 testcase 名解析结果（${parsed.join('、')}）不一致，以显式参数为准`)
  }
  const scenarioIds = explicit.length ? explicit : parsed
  if (!scenarioIds.length) return { registered: [], warnings: ['本次运行未绑定场景：未提供 scenarioIds，且 testcase 名中不含 scn_<8位hex> 标记'] }

  const resultsDir = join(workspace, 'verification', 'results', topModule)
  const path = join(resultsDir, 'scenario_hits.json')
  let existing: { scenarios?: Array<Record<string, unknown>> } = {}
  try { existing = JSON.parse(readFileSync(path, 'utf-8')) as typeof existing } catch { /* 首次写入 */ }
  let rtlHash: string
  try {
    rtlHash = computeRtlHash(workspace)
  } catch (error) {
    rtlHash = filesHash(input.rtlFiles)
    warnings.push(`引擎口径 RTL 哈希计算失败（${error instanceof Error ? error.message : String(error)}），已回退 filesHash；该证据的新鲜度判定可能不生效`)
  }
  const evidence = input.evidence.filter(Boolean).map((item) => {
    const absolute = resolve(workspace, item)
    return absolute.startsWith(resultsDir) ? relative(resultsDir, absolute) : absolute
  })
  const byId = new Map<string, Record<string, unknown>>()
  for (const item of existing.scenarios ?? []) if (typeof item.id === 'string') byId.set(item.id, item)
  for (const id of scenarioIds) {
    const previous = byId.get(id)
    byId.set(id, {
      ...previous,
      id,
      reached: true,
      passed: input.passed,
      reachCount: Number(previous?.reachCount ?? 0) + 1,
      rtlHash,
      evidence: [...new Set([...((previous?.evidence as string[] | undefined) ?? []), ...evidence])],
      generatedAt: new Date().toISOString()
    })
  }
  writeJsonAtomic(path, { rtlHash, scenarios: [...byId.values()] })
  return { registered: scenarioIds, warnings }
}

/** 证据工具执行后自动重建验证态势快照；失败不影响工具结果返回，仅返回警告文本。 */
function rebuildVerificationPosture(workspace: string): string | null {
  try {
    buildVerificationIntelligence(workspace)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// ============================================================
// 工具特定逻辑
// ============================================================

// ---- Verible/Verilator Lint ----

// verible 输出格式：file:line:col: message [rule-name]
const VERIBLE_LINE = /^(.+):(\d+):(\d+):\s*(.+?)\s*\[([a-z0-9-]+)\]\s*$/
// verilator 输出格式：%Error[-CODE]: file:line:col: message / %Warning-CODE: file:line:col: message
const VERILATOR_LINE = /^%(Error|Warning)(?:-([A-Z0-9_]+))?:\s*(.+):(\d+):(\d+):\s*(.+)$/

interface LintIssue {
  line: number
  column: number
  severity: 'error' | 'warning'
  rule: string
  message: string
}

function parseVerible(output: string): LintIssue[] {
  const issues: LintIssue[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = VERIBLE_LINE.exec(line.trim())
    if (!m) continue
    issues.push({
      line: Number(m[2]),
      column: Number(m[3]),
      severity: 'error',
      rule: m[5],
      message: m[4]
    })
  }
  return issues
}

function parseVerilator(output: string): { errors: LintIssue[]; warnings: LintIssue[] } {
  const errors: LintIssue[] = []
  const warnings: LintIssue[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = VERILATOR_LINE.exec(line.trim())
    if (!m) continue
    const issue: LintIssue = {
      line: Number(m[4]),
      column: Number(m[5]),
      severity: m[1] === 'Error' ? 'error' : 'warning',
      rule: m[2] ?? (m[1] === 'Error' ? 'error' : 'warning'),
      message: m[6]
    }
    if (issue.severity === 'error') errors.push(issue)
    else warnings.push(issue)
  }
  return { errors, warnings }
}

/** 尝试运行 verible-verilog-lint */
async function tryVerible(filePath: string, signal?: AbortSignal, rulesFile?: string, autofix?: boolean): Promise<{
  engine: 'verible'
  errors: LintIssue[]
  warnings: LintIssue[]
  fixedCode: string | null
} | null> {
  const veriblePath = await locateTool(['verible-verilog-lint'])
  if (!veriblePath) return null

  const args: string[] = []
  if (rulesFile) args.push(`--rules_config=${rulesFile}`)
  if (autofix) args.push('--autofix')
  args.push(filePath)

  const { stdout, stderr, code } = await run(veriblePath, args, toolEnv(veriblePath), signal)
  const allOutput = stdout + '\n' + stderr
  const issues = parseVerible(allOutput)

  let fixedCode: string | null = null
  if (autofix && code === 0) {
    try {
      fixedCode = readFileSync(filePath, 'utf-8')
    } catch { /* 忽略 */ }
  }

  return {
    engine: 'verible',
    errors: issues,
    warnings: [],
    fixedCode
  }
}

/** 回退到 verilator --lint-only */
async function tryVerilatorLint(filePath: string, signal?: AbortSignal): Promise<{
  engine: 'verilator'
  errors: LintIssue[]
  warnings: LintIssue[]
  fixedCode: null
}> {
  const { stdout, stderr } = await runWithFallback(
    VERILATOR_CANDIDATES,
    ['--lint-only', '-Wno-fatal', filePath],
    undefined,
    signal
  )
  const { errors, warnings } = parseVerilator(stdout + '\n' + stderr)
  return { engine: 'verilator', errors, warnings, fixedCode: null }
}

// ---- Yosys 可综合性检查 ----

// yosys ERROR/Warning 行
const YOSYS_ERROR = /^ERROR:\s*(.+)$/
const YOSYS_WARNING = /^Warning:\s*(.+)$/
// yosys 0.67+ stat 表格式："6 wires" / "2 cells"
const STAT_NUMBER = /^\s*(\d+)\s+(wires|cells|memories)\s*$/

interface SynthIssue {
  severity: 'error' | 'warning'
  message: string
}

interface SynthResult {
  synthesizable: boolean
  issues: SynthIssue[]
  cells: number | undefined
  wires: number | undefined
}

async function runYosysCheck(rtlFiles: string[], libraryFiles: string[], topModule?: string, signal?: AbortSignal): Promise<SynthResult> {
  const yosysPath = await locateTool(YOSYS_CANDIDATES)
  if (!yosysPath) throw new Error('Yosys 未安装或不在 PATH 中')

  const readCmd = `read_verilog -sv ${rtlFiles.map((f) => `"${f}"`).join(' ')}`
  const libraryCmd = libraryFiles.length > 0
    ? `read_verilog -sv -lib ${libraryFiles.map((f) => `"${f}"`).join(' ')}; `
    : ''
  const hierarchyCmd = topModule ? `hierarchy -top ${topModule}` : 'hierarchy -auto-top'
  const script = `${libraryCmd}${readCmd}; ${hierarchyCmd}; check; stat`

  const { stdout, stderr, code } = await run(yosysPath, ['-p', script], toolEnv(yosysPath), signal)

  const issues: SynthIssue[] = []
  let cells: number | undefined
  let wires: number | undefined

  for (const raw of (stdout + '\n' + stderr).split(/\r?\n/)) {
    const line = raw.trim()
    const errMatch = YOSYS_ERROR.exec(line)
    if (errMatch) {
      issues.push({ severity: 'error', message: errMatch[1] })
      continue
    }
    const warnMatch = YOSYS_WARNING.exec(line)
    if (warnMatch) {
      issues.push({ severity: 'warning', message: warnMatch[1] })
      continue
    }
    const statMatch = STAT_NUMBER.exec(line)
    if (statMatch) {
      const value = Number(statMatch[1])
      if (statMatch[2] === 'cells') cells = value
      else if (statMatch[2] === 'wires') wires = value
    }
  }

  const hasParsedError = issues.some((i) => i.severity === 'error')
  if (code !== null && code !== 0 && !hasParsedError) {
    issues.push({
      severity: 'error',
      message: `yosys 异常退出 (code=${code}): ${stderr.trim().split(/\r?\n/).pop() ?? ''}`
    })
  }

  return {
    synthesizable: !issues.some((i) => i.severity === 'error') && (code === null || code === 0),
    issues,
    cells,
    wires
  }
}

// ---- Verilator 仿真逻辑已下沉到 ./eda-bridge/simulation.ts（runVerilatorSimulation） ----

// ---- RTL 解析（端口/参数提取） ----

interface PortInfo {
  name: string
  direction: 'input' | 'output' | 'inout'
  width: number
}

interface ModuleInfo {
  moduleName: string
  ports: PortInfo[]
  parameters: Array<{ name: string; defaultValue: string }>
}

// 简化端口提取：匹配 module 声明中的 port 列表和参数
const MODULE_HEADER = /^\s*module\s+(\w+)\s*#?\(?([^;]*?)\)?\s*\(/
const PORT_DIR = /^\s*(input|output|inout)\s+(\[.*?\])?\s*(\w+)/
const PARAM_LINE = /^\s*parameter\s+(\w+)\s*=\s*([^,;]+)/

function extractModuleInfo(code: string, filePath: string): ModuleInfo {
  const lines = code.split(/\r?\n/)
  let moduleName = filePath.split(/[\\/]/).pop()?.replace(/\.(v|sv)$/i, '') ?? 'unknown'
  const ports: PortInfo[] = []
  const parameters: Array<{ name: string; defaultValue: string }> = []

  let inPortList = false
  let inParamList = false

  for (const raw of lines) {
    const line = raw.trim()
    // 跳过注释
    if (line.startsWith('//') || line.startsWith('/*')) continue

    // 匹配 module header
    const headerMatch = MODULE_HEADER.exec(line)
    if (headerMatch) {
      moduleName = headerMatch[1]
      inPortList = true
      continue
    }

    if (inPortList || inParamList) {
      // 参数提取
      const paramMatch = PARAM_LINE.exec(line)
      if (paramMatch) {
        parameters.push({
          name: paramMatch[1],
          defaultValue: paramMatch[2].trim()
        })
        inParamList = true
      }

      // 端口方向
      const portMatch = PORT_DIR.exec(line)
      if (portMatch) {
        const direction = portMatch[1] as 'input' | 'output' | 'inout'
        const widthSpec = portMatch[2]
        const name = portMatch[3]
        let width = 1
        if (widthSpec) {
          const wm = /\[(\d+):(\d+)\]/.exec(widthSpec)
          if (wm) width = Math.abs(Number(wm[1]) - Number(wm[2])) + 1
        }
        ports.push({ name, direction, width })
        inParamList = false
      }

      // 遇到 endmodule 或右括号结束
      if (line.includes('endmodule') || (line.startsWith(')') && !inParamList)) {
        break
      }
    }
  }

  return { moduleName, ports, parameters }
}

// ============================================================
// Pi 扩展注册
// ============================================================

const MAX_ISSUES_IN_REPORT = 10

/** 格式化检查结果展示（截断太长的问题列表） */
function formatIssues(issues: LintIssue[] | SynthIssue[]): string {
  if (issues.length === 0) return '无'
  const shown = issues.slice(0, MAX_ISSUES_IN_REPORT)
  const more = issues.length > MAX_ISSUES_IN_REPORT ? `\n…（共 ${issues.length} 条）` : ''
  return shown.map((i, idx) => {
    if ('line' in i && 'column' in i) {
      const li = i as LintIssue
      return `  ${idx + 1}. L${li.line}:${li.column} [${li.rule}] ${li.message}`
    }
    return `  ${idx + 1}. ${(i as SynthIssue).message}`
  }).join('\n') + more
}

function collectEvidenceFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectEvidenceFiles(full, predicate))
    else if (predicate(entry.name)) files.push(full)
  }
  return files
}

export default function (pi: ExtensionAPI): void {
  const loadIpLibraries = (): Array<{ name: string; type: string; ips: Array<Record<string, unknown>> }> => {
    const indexPath = process.env.MOONGLASS_IP_LIBRARY_INDEX
    if (!indexPath || !existsSync(indexPath)) return []
    try {
      const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as { libraries?: Array<{ name: string; type: string; ips: Array<Record<string, unknown>> }> }
      return Array.isArray(index.libraries) ? index.libraries : []
    } catch {
      return []
    }
  }

  pi.registerTool({
    name: 'ip_search',
    label: 'Search MoonGlass IP Library',
    description: '从 MoonGlass 结构化 IP 索引中按功能、协议、类型或接口角色检索候选，不读取整份大型索引。',
    promptSnippet: 'Search imported RTL IP, VIP and verification components before implementing from scratch',
    promptGuidelines: 'Use before architecture selection, RTL implementation, or verification environment construction. Treat results as candidates and inspect compatibility before use.',
    parameters: Type.Object({
      query: Type.String({ description: '功能或关键词，例如 AXI master、FIFO、UART' }),
      componentKind: Type.Optional(Type.Union([
        Type.Literal('rtl-ip'), Type.Literal('verification-component'), Type.Literal('mixed'), Type.Literal('reference')
      ])),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 8 }))
    }),
    async execute(_toolCallId, params) {
      const terms = String(params.query).toLowerCase().split(/\s+/).filter(Boolean)
      const kind = params.componentKind ? String(params.componentKind) : undefined
      const candidates = loadIpLibraries().flatMap((library) => library.ips.map((ip) => ({ library: library.name, ...ip })))
        .filter((ip) => !kind || ip.componentKind === kind || ip.componentKind === 'mixed')
        .map((ip) => {
          const searchable = JSON.stringify([ip.name, ip.type, ip.summary, ip.topModule, ip.protocols, ip.interfaceRoles]).toLowerCase()
          return { ip, score: terms.reduce((score, term) => score + (searchable.includes(term) ? 1 : 0), 0) }
        })
        .filter((entry) => terms.length === 0 || entry.score > 0)
        .sort((a, b) => b.score - a.score || Number(b.ip.confidence ?? 0) - Number(a.ip.confidence ?? 0))
        .slice(0, Number(params.limit ?? 8))
        .map(({ ip }) => ({
          id: ip.id, library: ip.library, name: ip.name, type: ip.type, componentKind: ip.componentKind,
          protocols: ip.protocols, interfaceRoles: ip.interfaceRoles, topModule: ip.topModule,
          summary: ip.summary, confidence: ip.confidence, path: ip.path
        }))
      return { content: [{ type: 'text', text: candidates.length > 0 ? JSON.stringify(candidates, null, 2) : '未找到匹配的 IP 候选。' }], details: candidates }
    }
  })

  pi.registerTool({
    name: 'ip_inspect',
    label: 'Inspect MoonGlass IP',
    description: '按稳定 ID 读取一个 IP 的完整结构化清单，包括 RTL、验证、文档和约束文件。',
    promptSnippet: 'Inspect a selected IP candidate before integrating it',
    promptGuidelines: 'Check protocols, role, source files, dependencies and documentation. Keep the source library read-only.',
    parameters: Type.Object({ id: Type.String({ description: 'ip_search 返回的 IP ID' }) }),
    async execute(_toolCallId, params) {
      const id = String(params.id)
      for (const library of loadIpLibraries()) {
        const ip = library.ips.find((candidate) => candidate.id === id)
        if (ip) {
          const detail = { library: library.name, libraryType: library.type, ...ip }
          return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }], details: detail }
        }
      }
      return { content: [{ type: 'text', text: `未找到 IP：${id}` }], details: { id, found: false } }
    }
  })

  pi.registerTool({
    name: 'generate_sram_macro_views',
    label: 'Generate SRAM Macro Views',
    description: '按真实 SRAM 宏名称和固定 depth/width 生成仿真行为模型、综合 blackbox、wrapper 与 manifest；不会伪造 Liberty。',
    promptSnippet: 'Generate matching SRAM simulation and synthesis views when the real memory compiler model is unavailable',
    promptGuidelines: 'Confirm macro name, exact depth, width, port type and control polarity first. Generated behavioral files are simulation-only and blackbox files are synthesis-only. Never claim timing, area or power signoff without the matching Liberty.',
    parameters: Type.Object({
      macroName: Type.String({ description: '真实 SRAM 实体模块名，例如 RFSP288X80M4LL' }),
      wrapperName: Type.String({ description: '项目使用的 wrapper 模块名，例如 SRAMS288X80_CPU' }),
      depth: Type.Number({ minimum: 1, description: '有效字数，例如 288' }),
      width: Type.Number({ minimum: 1, description: '每字位宽，例如 80' }),
      outputDir: Type.Optional(Type.String({ description: '项目内输出目录，默认 rtl/macros/<macroName>' }))
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const script = process.env.MOONGLASS_SRAM_GENERATOR
      if (!script || !existsSync(script)) {
        return { content: [{ type: 'text', text: 'MoonGlass SRAM 生成器未安装或路径不可用。' }], details: { ok: false } }
      }
      const workspace = resolve(ctx.cwd)
      const outputDir = resolve(workspace, String(params.outputDir ?? join('rtl', 'macros', String(params.macroName))))
      const rel = relative(workspace, outputDir)
      if (rel.startsWith('..') || rel === '') {
        return { content: [{ type: 'text', text: '输出目录必须是当前项目工作区内的子目录。' }], details: { ok: false } }
      }
      const python = await locateTool(process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python'])
      if (!python) {
        return { content: [{ type: 'text', text: '未找到 Python，无法生成 SRAM 视图。' }], details: { ok: false } }
      }
      const result = await run(python, [
        script, '--macro-name', String(params.macroName), '--wrapper-name', String(params.wrapperName),
        '--depth', String(params.depth), '--width', String(params.width), '--output-dir', outputDir
      ], toolEnv(python), signal, workspace, 120_000)
      if (result.code !== 0) {
        return { content: [{ type: 'text', text: `SRAM 视图生成失败：\n${result.stderr || result.stdout}` }], details: { ok: false, ...result } }
      }
      let details: unknown = { ok: true, outputDir }
      try { details = JSON.parse(result.stdout) } catch { /* 保留文本结果 */ }
      return {
        content: [{ type: 'text', text: `SRAM 视图已生成到 ${rel.replace(/\\/g, '/')}。\n注意：没有匹配 Liberty 时只能用于功能仿真和 blackbox 综合，不能用于 SRAM 时序、面积或功耗签核。` }],
        details
      }
    }
  })

  pi.registerTool({
    name: 'request_user_decision',
    label: 'Request User Decision',
    description: '在 MoonGlass 对话中展示结构化单选或多选决策卡。适用于需求、规格、架构和约束等需要用户明确选择的场景。',
    promptSnippet: 'Ask the user to choose among structured engineering options in the MoonGlass UI',
    promptGuidelines: 'Use this instead of writing numbered choices in plain text. Provide concise trade-offs, mark at most one recommended option, allow custom requirements unless inappropriate, and stop your response after calling the tool until the user answers.',
    parameters: Type.Object({
      id: Type.String({ description: '稳定且语义化的决策 ID，例如 spec.data_width' }),
      title: Type.String({ description: '简短决策标题' }),
      prompt: Type.Optional(Type.String({ description: '决策背景或需要用户回答的问题' })),
      mode: Type.Union([Type.Literal('single'), Type.Literal('multiple')]),
      options: Type.Array(Type.Object({
        id: Type.String(),
        label: Type.String(),
        description: Type.Optional(Type.String()),
        recommended: Type.Optional(Type.Boolean())
      }), { minItems: 2, maxItems: 12 }),
      allowCustom: Type.Optional(Type.Boolean({ description: '是否允许用户补充自己的要求，默认 true' })),
      customLabel: Type.Optional(Type.String({ description: '自定义输入框标签' })),
      required: Type.Optional(Type.Boolean({ description: '是否必须选择预设项或填写自定义要求，默认 true' }))
    }),
    async execute(_toolCallId, params) {
      const request = {
        id: String(params.id),
        title: String(params.title),
        prompt: params.prompt ? String(params.prompt) : undefined,
        mode: params.mode as 'single' | 'multiple',
        options: params.options,
        allowCustom: params.allowCustom !== false,
        customLabel: params.customLabel ? String(params.customLabel) : '补充你的要求（可选）',
        required: params.required !== false
      }
      return {
        content: [{
          type: 'text',
          text: `MOONGLASS_DECISION_REQUEST:${JSON.stringify(request)}\n等待用户在 MoonGlass 决策卡中回答。不要自行替用户选择。`
        }],
        details: request
      }
    }
  })

  // ============================================================
  // 工具 1: run_verible_lint — Verilog/SystemVerilog Lint 检查
  // ============================================================
  pi.registerTool({
    name: 'run_verible_lint',
    label: 'Run Verible Lint',
    description: '执行 RTL Lint。缺省按 design.json/filelist.f 对全设计进行 Verilator 联合 Lint 与顶层 elaboration；指定 filePath 时只做单文件快速检查。',
    promptSnippet: 'Run full-design RTL lint/elaboration or a fast single-file lint',
    promptGuidelines: 'Use file scope while editing. Before declaring RTL complete, omit filePath and run full-design lint/elaboration; a single-file PASS is never completion evidence.',
    parameters: Type.Object({
      filePath: Type.Optional(Type.String({ description: '可选：目标文件路径。省略时检查完整设计并 elaboration 顶层' })),
      rulesFile: Type.Optional(Type.String({ description: 'Verible 规则配置文件路径（可选，仅 verible 引擎生效）' })),
      autofix: Type.Optional(Type.Boolean({ description: '是否启用 autofix（仅 verible 支持，会就地修改文件）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requestedPath = params.filePath as string | undefined
      const filePath = requestedPath ? resolve(ctx.cwd, requestedPath) : undefined
      const rulesFile = params.rulesFile as string | undefined
      const autofix = params.autofix as boolean | undefined

      if (filePath && !existsSync(filePath)) {
        return {
          content: [{ type: 'text', text: `错误：文件不存在 — ${filePath}` }],
          isError: true,
          details: {}
        }
      }

      let result: { engine: string; errors: LintIssue[]; warnings: LintIssue[]; fixedCode: string | null }
      let target: string
      if (filePath) {
        // 单文件快速检查：优先 Verible，没有则回退 Verilator。
        const veribleResult = await tryVerible(filePath, signal, rulesFile, autofix)
        result = veribleResult ?? await tryVerilatorLint(filePath, signal)
        target = filePath
      } else {
        if (autofix) throw new Error('全设计 Lint 不支持 autofix；请指定 filePath 后执行局部自动修复')
        const inputs = readRtlInputs(ctx.cwd)
        if (inputs.designFiles.length === 0) throw new Error('工作区没有可检查的设计 RTL')
        const designResult = await runDesignLint({
          files: inputs.designFiles,
          libraryFiles: inputs.libraryFiles,
          topModule: inputs.topModule,
          includeDirs: inputs.includeDirs,
          defines: inputs.defines
        })
        result = { ...designResult, fixedCode: null }
        target = `完整设计（${inputs.designFiles.length} 个文件，顶层 ${inputs.topModule ?? '自动识别'}）`
      }

      const errorCount = result.errors.length
      const warningCount = result.warnings.length
      const passed = errorCount === 0

      const report = [
        `## Lint Result — ${target}`,
        `**引擎**: ${result.engine}`,
        `**结果**: ${passed ? '✅ 通过' : '❌ 失败'}`,
        `**Error**: ${errorCount} / **Warning**: ${warningCount}`,
        '',
      ]
      if (errorCount > 0) {
        report.push('### Error 列表')
        report.push(formatIssues(result.errors))
        report.push('')
      }
      if (warningCount > 0) {
        report.push('### Warning 列表')
        report.push(formatIssues(result.warnings))
        report.push('')
      }
      if (autofix && result.fixedCode) {
        report.push('✅ autofix 已完成，文件已就地更新。')
      }

      return {
        content: [{ type: 'text', text: report.join('\n') }],
        details: {
          engine: result.engine,
          passed,
          errorCount,
          warningCount,
          errors: result.errors.slice(0, MAX_ISSUES_IN_REPORT),
          warnings: result.warnings.slice(0, MAX_ISSUES_IN_REPORT),
          autofixed: autofix && result.fixedCode !== null
        }
      }
    }
  })

  // ============================================================
  // 工具 2: check_synthesizability — Yosys 可综合性检查
  // ============================================================
  pi.registerTool({
    name: 'check_synthesizability',
    label: 'Check Synthesizability',
    description: '使用 Yosys 对 RTL 文件进行可综合性检查，包括语法解析、层次化检查和逻辑综合可行性。返回是否可综合、问题列表和资源估算（cells/wires）。',
    promptSnippet: 'Check if RTL code is synthesizable using Yosys',
    promptGuidelines: 'After lint, pass design files as rtlFiles and SRAM blackbox views as libraryFiles. Never pass behavioral or physical macro views to Yosys synthesis.',
    parameters: Type.Object({
      rtlFiles: Type.Array(Type.String(), { description: '需要检查的 RTL 文件路径列表' }),
      libraryFiles: Type.Optional(Type.Array(Type.String(), { description: '宏/库 blackbox Verilog；使用 read_verilog -lib' })),
      topModule: Type.Optional(Type.String({ description: '顶层模块名称（可选，缺省自动识别）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rtlFiles = (params.rtlFiles as string[]).map((file) => resolve(ctx.cwd, file))
      const libraryFiles = ((params.libraryFiles as string[] | undefined) ?? []).map((file) => resolve(ctx.cwd, file))
      const topModule = params.topModule as string | undefined

      // 验证所有文件存在
      const missing = [...rtlFiles, ...libraryFiles].filter((f) => !existsSync(f))
      if (missing.length > 0) {
        return {
          content: [{ type: 'text', text: `错误：以下文件不存在:\n${missing.map((f) => `  - ${f}`).join('\n')}` }],
          isError: true,
          details: {}
        }
      }

      try {
        const result = await runYosysCheck(rtlFiles, libraryFiles, topModule, signal)

        const errorCount = result.issues.filter((i) => i.severity === 'error').length
        const warningCount = result.issues.filter((i) => i.severity === 'warning').length

        const report = [
          `## Synthesizability Check`,
          `**文件**: ${rtlFiles.join(', ')}`,
          `**顶层**: ${topModule ?? '自动识别'}`,
          `**Blackbox 宏视图**: ${libraryFiles.length} 个`,
          `**结果**: ${result.synthesizable ? '✅ 可综合' : '❌ 不可综合'}`,
          '',
        ]
        if (errorCount > 0) {
          report.push(`**Error**: ${errorCount}`)
          report.push(formatIssues(result.issues.filter((i) => i.severity === 'error')))
          report.push('')
        }
        if (warningCount > 0) {
          report.push(`**Warning**: ${warningCount}`)
          report.push(formatIssues(result.issues.filter((i) => i.severity === 'warning')))
          report.push('')
        }
        if (result.cells !== undefined || result.wires !== undefined) {
          report.push('### 资源估算')
          if (result.cells !== undefined) report.push(`- Cells: ${result.cells}`)
          if (result.wires !== undefined) report.push(`- Wires: ${result.wires}`)
          report.push('')
        }

        return {
          content: [{ type: 'text', text: report.join('\n') }],
          details: {
            synthesizable: result.synthesizable,
            errorCount,
            warningCount,
            cells: result.cells,
            wires: result.wires,
            issues: result.issues.slice(0, MAX_ISSUES_IN_REPORT)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `可综合性检查失败: ${message}\n\n请确认 Yosys 已安装并在 PATH 中（oss-cad-suite / 系统安装）。` }],
          isError: true,
          details: {}
        }
      }
    }
  })

  // ============================================================
  // 工具 3: read_verilog — 解析 Verilog 模块提取端口/参数
  // ============================================================
  pi.registerTool({
    name: 'read_verilog',
    label: 'Read Verilog',
    description: '解析 Verilog/SystemVerilog 文件，提取模块名、端口列表（名/方向/位宽）和参数列表。帮助 Agent 理解已有 RTL 的接口。',
    promptSnippet: 'Parse a Verilog file to extract module interface (ports, parameters)',
    parameters: Type.Object({
      filePath: Type.String({ description: '目标 Verilog/SystemVerilog 文件路径' })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const filePath = params.filePath as string

      if (!existsSync(filePath)) {
        return {
          content: [{ type: 'text', text: `错误：文件不存在 — ${filePath}` }],
          isError: true,
          details: {}
        }
      }

      const stat = statSync(filePath)
      if (!stat.isFile()) {
        return {
          content: [{ type: 'text', text: `错误：路径不是文件 — ${filePath}` }],
          isError: true,
          details: {}
        }
      }

      const code = readFileSync(filePath, 'utf-8')
      const info = extractModuleInfo(code, filePath)

      const report = [
        `## 模块: ${info.moduleName}`,
        '',
        '### 端口',
        '| 名称 | 方向 | 位宽 |',
        '|------|------|------|',
      ]
      for (const p of info.ports) {
        report.push(`| ${p.name} | ${p.direction} | ${p.width} |`)
      }

      if (info.parameters.length > 0) {
        report.push('', '### 参数', '| 名称 | 默认值 |', '|------|--------|')
        for (const p of info.parameters) {
          report.push(`| ${p.name} | \`${p.defaultValue}\` |`)
        }
      }

      return {
        content: [{ type: 'text', text: report.join('\n') }],
        details: {
          moduleName: info.moduleName,
          ports: info.ports,
          parameters: info.parameters
        }
      }
    }
  })

  // ============================================================
  // 工具 4: collect_rtl_files — 扫描工作区 RTL 文件
  // ============================================================
  pi.registerTool({
    name: 'collect_rtl_files',
    label: 'Collect RTL Files',
    description: '按 rtl/design.json 与 filelist.f 收集设计源，并分离仿真、blackbox 和物理宏视图。',
    promptSnippet: 'Scan project directory for RTL source files',
    promptGuidelines: 'Use designFiles for RTL, simulationFiles only for simulation, libraryFiles only with Yosys -lib, and never compile physicalFiles.',
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: '扫描目录（缺省为工作区 rtl/）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const dir = resolve(ctx.cwd, (params.directory as string | undefined) ?? 'rtl')

      const inputs = params.directory ? null : readRtlInputs(ctx.cwd)
      const files = inputs?.designFiles ?? collectRtlFiles(dir)
      if (files.length === 0) {
        return {
          content: [{ type: 'text', text: `工作目录 ${dir} 中未发现 RTL 文件（*.v/*.sv）。` }],
          details: { files: [], designFiles: [], simulationFiles: [], libraryFiles: [], physicalFiles: [] }
        }
      }

      // 尝试提取每个文件的模块名
      const modules: Array<{ file: string; module: string }> = []
      for (const file of files) {
        try {
          const short = file.slice(dir.length).replace(/^[/\\]/, '') || file
          const code = readFileSync(file, 'utf-8')
          const info = extractModuleInfo(code, file)
          modules.push({ file: short, module: info.moduleName })
        } catch {
          modules.push({ file, module: '（解析失败）' })
        }
      }

      const report = [
        `## RTL 文件清单（${files.length} 个）`,
        '',
        '| 文件 | 模块名 |',
        '|------|--------|',
        ...modules.map((m) => `| ${m.file} | ${m.module} |`)
      ]

      return {
        content: [{ type: 'text', text: report.join('\n') }],
        details: {
          files: modules,
          designFiles: files,
          simulationFiles: inputs?.simulationFiles ?? [],
          libraryFiles: inputs?.libraryFiles ?? [],
          physicalFiles: inputs?.physicalFiles ?? [],
          manifestPath: inputs?.manifestPath
        }
      }
    }
  })

  // ============================================================
  // 工具 5: generate_tb — 从 RTL 端口生成 Verilator C++ 测试台
  // ============================================================
  pi.registerTool({
    name: 'generate_tb',
    label: 'Generate Testbench',
    description: '基于 Verilog/SystemVerilog 模块的端口定义，自动生成 Verilator C++ 测试台框架（.cpp）。支持时钟生成、信号初始化、时序驱动和波形输出。生成的文件内容可被 Agent 后续修改定制。',
    promptSnippet: 'Generate a Verilator C++ testbench from an RTL module',
    promptGuidelines: 'Use generate_tb after writing RTL to create a testbench. The generated C++ testbench can be modified for specific test cases.',
    parameters: Type.Object({
      rtlFile: Type.String({ description: '目标 RTL 文件路径（用于提取端口定义）' }),
      outputPath: Type.Optional(Type.String({ description: '输出 .cpp 文件路径（缺省为 verification/<module>_tb/sim/sim_main.cpp）' })),
      clockName: Type.Optional(Type.String({ description: '时钟信号名（缺省自动检测 i_clk / clk）' })),
      resetName: Type.Optional(Type.String({ description: '复位信号名（缺省自动检测 i_rst_n / rst_n）' })),
      resetActiveLow: Type.Optional(Type.Boolean({ description: '是否低电平复位（缺省 true）' })),
      numCycles: Type.Optional(Type.Number({ description: '仿真运行时钟周期数（缺省 100）' })),
      trace: Type.Optional(Type.Boolean({ description: '是否生成 VCD 波形（缺省 true）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rtlFile = params.rtlFile as string
      if (!existsSync(rtlFile)) {
        return {
          content: [{ type: 'text', text: `错误：RTL 文件不存在 — ${rtlFile}` }],
          isError: true, details: {}
        }
      }

      const code = readFileSync(rtlFile, 'utf-8')
      const info = extractModuleInfo(code, rtlFile)

      // 自动检测时钟和复位信号
      const clockName = (params.clockName as string | undefined) ??
        info.ports.find((p) => /^(i_)?clk$/i.test(p.name))?.name ?? 'i_clk'
      const resetName = (params.resetName as string | undefined) ??
        info.ports.find((p) => /^(i_)?rst(_n)?$/i.test(p.name))?.name ?? 'i_rst_n'
      const resetActiveLow = params.resetActiveLow as boolean | undefined ?? true
      const numCycles = params.numCycles as number | undefined ?? 100
      const trace = params.trace as boolean | undefined ?? true

      const baseName = info.moduleName
      const vBase = 'V' + baseName
      const outPath = resolve(
        ctx.cwd,
        (params.outputPath as string | undefined) ??
          join('verification', `${baseName}_tb`, 'sim', 'sim_main.cpp')
      )

      const tbCode = `// ============================================================
// ${baseName} Verilator Testbench
// 自动生成时间: ${new Date().toISOString()}
// 基于: ${rtlFile}
// ============================================================

#include <verilated.h>
#include "${vBase}.h"

${trace ? '#include <verilated_vcd_c.h>' : ''}

vluint64_t main_time = 0;
double sc_time_stamp() { return main_time; }

int main(int argc, char** argv) {
  Verilated::commandArgs(argc, argv);
  Verilated::traceEverOn(${trace ? 'true' : 'false'});

  // 实例化 DUT
  ${vBase}* top = new ${vBase};

${trace ? `  // 波形追踪
  VerilatedVcdC* tfp = nullptr;
  tfp = new VerilatedVcdC;
  top->trace(tfp, 99);
  tfp->open("${baseName}.vcd");` : ''}

  // 初始化信号
  top->${clockName} = 0;
  top->${resetName} = ${resetActiveLow ? '1' : '0'};

  // 释放复位
  top->${resetName} = ${resetActiveLow ? '0' : '1'};
  for (int i = 0; i < 5; i++) {
    top->${clockName} = !top->${clockName};
    top->eval();
  }
  top->${resetName} = ${resetActiveLow ? '1' : '0'};

  // 主仿真循环
  for (int cycle = 0; cycle < ${numCycles}; cycle++) {
    // 时钟上升沿
    top->${clockName} = 1;
    top->eval();
${trace ? `    if (tfp) tfp->dump(main_time);\n    main_time++;` : ''}

    // 时钟下降沿
    top->${clockName} = 0;
    top->eval();
${trace ? `    if (tfp) tfp->dump(main_time);\n    main_time++;` : ''}

    if (Verilated::gotFinish()) break;
  }

  // ====== 在此添加用户测试激励 ======
  // 示例：写入 DUT 输入
  // top->i_data = 0xAA;
  // top->eval();
  // printf("o_result = 0x%x\\n", top->o_result);
  // ====== 用户测试逻辑结束 ======

  // 清理
  top->final();
${trace ? '  if (tfp) tfp->close();' : ''}
  delete top;
  printf("\\n*** ${baseName}: Simulation finished (%d cycles) ***\\n", ${numCycles});
  return 0;
}
`

      // 写出文件
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, tbCode, 'utf-8')

      const portTable = [
        '| 名称 | 方向 | 位宽 |',
        '|------|------|------|',
        ...info.ports.map((p) => `| ${p.name} | ${p.direction} | ${p.width} |`)
      ]

      const report = [
        `## 测试台已生成 — ${outPath}`,
        '',
        `**目标模块**: ${info.moduleName}`,
        `**时钟信号**: ${clockName}`,
        `**复位信号**: ${resetName}（${resetActiveLow ? '低电平有效' : '高电平有效'}）`,
        `**仿真周期**: ${numCycles}`,
        `**波形输出**: ${trace ? '✅ VCD 已启用' : '❌ 关闭'}`,
        '',
        '### 端口映射',
        ...portTable,
        '',
        '### 下一步',
        '',
        '1. 编辑测试台文件添加具体测试逻辑（搜索 "用户测试激励"）',
        '2. 使用 run_simulation 工具运行仿真（需要 verilator 在 PATH 中）',
        '3. 用 gtkwave 打开 .vcd 波形文件查看结果',
      ]

      return {
        content: [{ type: 'text', text: report.join('\n') }],
        details: {
          outputPath: outPath,
          moduleName: info.moduleName,
          ports: info.ports,
          clockName,
          resetName,
          resetActiveLow,
          numCycles,
          trace
        }
      }
    }
  })

  // ============================================================
  // 工具 6: run_simulation — Cocotb（推荐）或旧式 Verilator C++ 仿真
  // ============================================================
  pi.registerTool({
    name: 'run_simulation',
    label: 'Run Simulation',
    description: '运行 Cocotb Python testbench（推荐，Windows 缺省 Icarus）或兼容旧式 Verilator C++ testbench；统一输出日志、JUnit、result.json 和波形。提供 scenarioIds 时自动把 PASS/FAIL 登记到 scenario_hits.json 并重建验证态势；scenario_hits.json 由本工具独占写入，禁止手工编辑。',
    promptSnippet: 'Run Cocotb or legacy C++ RTL simulation and collect artifacts',
    promptGuidelines: 'Use mode=cocotb with testModule/testDir for MoonGlass verification environments. On Windows prefer simulator=icarus. Use mode=cpp only for an existing C++ testbench. Pass scenarioIds from select_next_verification_batch so scenario hits are auto-registered; never hand-write scenario_hits.json.',
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal('cocotb'), Type.Literal('cpp')], { description: '缺省 cocotb；cpp 仅兼容旧项目' })),
      topModule: Type.String({ description: '顶层模块名（对应 RTL module 名称）' }),
      rtlFiles: Type.Array(Type.String(), { description: 'RTL 文件路径列表' }),
      testModule: Type.Optional(Type.String({ description: 'Cocotb Python 模块名，例如 tests.test_uart（不要带 .py）' })),
      testDir: Type.Optional(Type.String({ description: 'Cocotb 环境根目录，加入 PYTHONPATH' })),
      testcase: Type.Optional(Type.String({ description: '仅运行指定 @cocotb.test 测试，可选' })),
      scenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }), { description: '本用例定向关闭的场景 ID，来自 select_next_verification_batch 返回的批次' })),
      simulator: Type.Optional(Type.Union([Type.Literal('icarus'), Type.Literal('verilator')], { description: 'Cocotb 后端；Windows 缺省 icarus' })),
      tbCpp: Type.Optional(Type.String({ description: 'mode=cpp 时的 C++ 测试台路径' })),
      trace: Type.Optional(Type.Boolean({ description: '是否生成波形，缺省 true' })),
      rtlCoverage: Type.Optional(Type.Boolean({ description: 'Verilator 后端是否采集 RTL 行、条件/表达式、翻转和 FSM 覆盖率；缺省 true' })),
      functionalCoverageFile: Type.Optional(Type.String({ description: '功能覆盖率 JSON 路径；测试也可读取 MOONGLASS_FUNCTIONAL_COVERAGE_FILE 环境变量写入默认路径' })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, description: '仅在项目有明确依据时设置硬超时；缺省不按 wall-clock 强制终止' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const topModule = params.topModule as string
      const rtlFiles = (params.rtlFiles as string[]).map((file) => resolve(ctx.cwd, file))
      const mode = (params.mode as 'cocotb' | 'cpp' | undefined) ?? 'cocotb'
      const tbCpp = params.tbCpp ? resolve(ctx.cwd, params.tbCpp as string) : undefined
      const trace = params.trace as boolean | undefined ?? true
      const testDir = mode === 'cocotb' ? resolve(ctx.cwd, (params.testDir as string | undefined) ?? `verification/${topModule}_tb`) : undefined

      if (mode === 'cocotb' && !(params.testModule as string | undefined)?.trim()) {
        return {
          content: [{ type: 'text', text: '错误：mode=cocotb 时必须提供 testModule（Python 模块名，不带 .py）' }],
          isError: true,
          details: {}
        }
      }

      // 验证输入文件
      const missing: string[] = []
      if (mode === 'cpp' && (!tbCpp || !existsSync(tbCpp))) missing.push(tbCpp ?? 'tbCpp（未提供）')
      for (const f of rtlFiles) {
        if (!existsSync(f)) missing.push(f)
      }
      if (missing.length > 0) {
        return {
          content: [{ type: 'text', text: `错误：以下文件不存在:\n${missing.map((f) => `  - ${f}`).join('\n')}` }],
          isError: true,
          details: {}
        }
      }

      if (testDir) {
        onUpdate?.({ content: [{ type: 'text', text: '正在执行 Python 测试完整性预检（语法、重复测试与重复注入标记）…' }] })
        const preflight = await validatePythonTests(testDir, signal)
        if (!preflight.ok) {
          return {
            content: [{ type: 'text', text: `验证环境完整性检查失败，已阻止仿真。测试文件可能被重复注入或缩进已损坏：\n${preflight.issues.map((item) => `- ${item}`).join('\n')}\n\n请先修复测试文件；不要在损坏文件上继续追加脚本。` }],
            isError: true,
            details: { diagnosticMode: 'TESTBENCH_INTEGRITY', issues: preflight.issues }
          }
        }
      }

      const simulationStartedAt = Date.now()
      try {
        onUpdate?.({ content: [{ type: 'text', text: `测试预检通过，正在运行 ${params.testcase ? `单用例 ${String(params.testcase)}` : '回归'}。缺省不使用固定 wall-clock 或仿真周期上限。` }] })
        const resultDir = resolve(ctx.cwd, 'verification', 'results', topModule)
        const result = mode === 'cocotb'
          ? await runCocotbSimulation({
              topModule,
              rtlFiles,
              testModule: params.testModule as string,
              testDir: testDir!,
              testcase: params.testcase as string | undefined,
              simulator: params.simulator as 'icarus' | 'verilator' | undefined,
              waves: trace,
              rtlCoverage: params.rtlCoverage as boolean | undefined,
              functionalCoverageFile: params.functionalCoverageFile ? resolve(ctx.cwd, params.functionalCoverageFile as string) : undefined,
              signal,
              timeoutSec: params.timeoutSec as number | undefined,
              buildDir: resolve(ctx.cwd, 'verification', `${topModule}_tb`, 'sim', 'sim_build'),
              resultDir
            })
          : await runVerilatorSimulation({
              topModule,
              tbCpp: tbCpp!,
              rtlFiles,
              trace,
              rtlCoverage: params.rtlCoverage as boolean | undefined,
              signal,
              buildDir: resolve(ctx.cwd, 'verification', `${topModule}_tb`, 'sim', 'obj_dir'),
              resultDir
            })

        const report = [
          `## 仿真结果 — ${topModule}`,
          '',
          `**结果**: ${result.passed ? '✅ 通过' : '❌ 失败'}`,
          `**模式**: ${mode === 'cocotb' ? `Cocotb / ${(params.simulator as string | undefined) ?? 'icarus'}` : 'Verilator C++'}`,
          `**VCD 波形**: ${result.vcdPath ? `✅ ${result.vcdPath}` : '❌ 未生成'}`,
          `**编译日志**: ${result.compileLogPath}`,
          `**仿真日志**: ${result.simulationLogPath}`,
          `**结构化结果**: ${result.resultPath}`,
          `**RTL 覆盖率**: ${result.coverage?.lineCoverage === undefined ? '未采集' : `行 ${result.coverage.lineCoverage}% / 条件 ${result.coverage.branchCoverage ?? '暂无'}%`}`,
          `**功能覆盖率**: ${result.coverage?.functionalCoverage === undefined ? '未提供' : `${result.coverage.functionalCoverage}%`}`,
        ]

        // 回显收紧：PASS 只给结论行与产物路径；FAIL 只给日志首尾摘录与失败指纹行，
        // 全文留在磁盘按需读取，避免大段日志挤占上下文。
        if (!result.passed) {
          const lines = result.log.split(/\r?\n/)
          const fingerprintLines = lines.filter((line) => /error|fail|assert|mismatch|timeout|traceback|exception|fatal/i.test(line)).slice(-12)
          report.push('', `### 输出日志摘录（完整日志见 ${result.simulationLogPath}）`, '')
          if (lines.length <= 80) {
            report.push('```', ...lines, '```')
          } else {
            report.push(`开头 30 行（共 ${lines.length} 行）：`, '```', ...lines.slice(0, 30), '```', '', '结尾 50 行：', '```', ...lines.slice(-50), '```')
          }
          if (fingerprintLines.length) {
            report.push('', '失败指纹行：', '```', ...fingerprintLines, '```')
          }
        }

        if (result.vcdPath) {
          report.push('', '### 波形查看', '', `gtkwave ${result.vcdPath}`)
        }

        if (!result.passed) {
          report.push('', '### 调试建议', '', '1. 固定失败用例与 seed，读取完整日志和已有波形', '2. 只提出一个根因假设并做最小修改', '3. 若重复失败，暂停盲改 RTL，先增强 Checker、Assertion、事务追踪和观察点', '4. 不得修改正确预期来迎合 RTL')
        }

        const diagnostic = updateDiagnosticControl({
          workspace: resolve(ctx.cwd), topModule, testcase: params.testcase as string | undefined, passed: result.passed,
          log: result.log, rtlFiles, testDir, hasWaveform: Boolean(result.vcdPath),
          durationMs: Date.now() - simulationStartedAt,
          evidence: [result.compileLogPath, result.simulationLogPath, result.resultPath, result.vcdPath ?? '', result.coverageReportPath ?? '']
        })
        report.push('', '### 渐进式诊断控制', '', `**诊断等级**: ${diagnostic.attempts.at(-1)?.diagnosticLevel ?? 'L0'}`, `**本次耗时**: ${Math.round((diagnostic.attempts.at(-1)?.durationMs ?? 0) / 1000)} 秒（仅记录，不据此强制终止）`, `**当前模式**: ${diagnostic.mode}`, `**建议**: ${diagnostic.recommendation}`, '', '诊断账本：verification/results/diagnostic-control.json')

        // 证据管线：PASS/FAIL 都自动登记 scenario_hits（失败同样是证据），并重建验证态势
        const hits = writeScenarioHits(resolve(ctx.cwd), topModule, {
          scenarioIds: params.scenarioIds as string[] | undefined,
          testcase: params.testcase as string | undefined,
          passed: result.passed,
          rtlFiles,
          evidence: [result.resultPath, result.simulationLogPath, result.vcdPath ?? '']
        })
        report.push('', '### Scenario 证据登记', '')
        if (hits.registered.length) report.push(`已自动登记 ${hits.registered.length} 个场景到 scenario_hits.json：${hits.registered.join('、')}`)
        for (const warning of hits.warnings) report.push(`⚠️ ${warning}`)
        const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
        report.push(rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次仿真结果）：${rebuildError}` : '态势快照已自动重建，验证态势页刷新即可见')

        return {
          content: [{ type: 'text', text: report.join('\n') }],
          details: {
            passed: result.passed,
            logPreview: result.log.slice(0, 1000),
            vcdPath: result.vcdPath,
            compileLogPath: result.compileLogPath,
            simulationLogPath: result.simulationLogPath,
            resultPath: result.resultPath,
            coverage: result.coverage,
            coverageReportPath: result.coverageReportPath,
            diagnostic,
            scenarioHits: hits.registered
          },
          isError: !result.passed
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const diagnostic = updateDiagnosticControl({
          workspace: resolve(ctx.cwd), topModule, testcase: params.testcase as string | undefined, passed: false,
          log: message, rtlFiles, testDir, hasWaveform: false, evidence: [],
          durationMs: Date.now() - simulationStartedAt
        })
        return {
          content: [{ type: 'text', text: `仿真执行失败: ${message}\n\n诊断等级：${diagnostic.attempts.at(-1)?.diagnosticLevel ?? 'L0'}\n当前模式：${diagnostic.mode}\n建议：${diagnostic.recommendation}` }],
          isError: true,
          details: { diagnostic }
        }
      }
    }
  })

  // ============================================================
  // 工具 7: generate_sdc — 生成基础时钟与 I/O 约束
  // ============================================================
  pi.registerTool({
    name: 'generate_sdc',
    label: 'Generate SDC',
    description: '根据时钟、时钟不确定度和 I/O delay 生成 SDC 约束文件。输出到工程目录，供逻辑综合和后续 STA 使用。',
    promptSnippet: 'Generate an SDC constraints file for synthesis',
    promptGuidelines: 'Use generate_sdc before run_logic_synthesis. Confirm clock periods and I/O delays with the user when they are not specified in project requirements.',
    parameters: Type.Object({
      clocks: Type.Array(Type.Object({
        name: Type.String({ description: '时钟名称，例如 core_clk' }),
        port: Type.String({ description: '顶层时钟端口，例如 i_clk' }),
        periodNs: Type.Number({ description: '时钟周期，单位 ns' }),
        dutyCycle: Type.Optional(Type.Number({ description: '占空比，0 到 1，默认 0.5' })),
        uncertaintyNs: Type.Optional(Type.Number({ description: '时钟不确定度，单位 ns' }))
      }), { minItems: 1 }),
      ioDelays: Type.Optional(Type.Array(Type.Object({
        direction: Type.Union([Type.Literal('input'), Type.Literal('output')]),
        ports: Type.Array(Type.String(), { minItems: 1 }),
        delayNs: Type.Number({ description: 'I/O delay，单位 ns' }),
        clockName: Type.String({ description: '关联的时钟名称' })
      }))),
      outputPath: Type.Optional(Type.String({ description: '输出路径，缺省为 imp/constraints/design.sdc' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const outputPath = resolve(ctx.cwd, (params.outputPath as string | undefined) ?? 'imp/constraints/design.sdc')
      try {
        const result = generateSdc({
          clocks: params.clocks as Array<{
            name: string
            port: string
            periodNs: number
            dutyCycle?: number
            uncertaintyNs?: number
          }>,
          ioDelays: params.ioDelays as Array<{
            direction: 'input' | 'output'
            ports: string[]
            delayNs: number
            clockName: string
          }> | undefined,
          outputPath
        })
        return {
          content: [{
            type: 'text',
            text: [
              '## SDC 生成完成',
              '',
              `**文件**: ${result.filePath}`,
              `**时钟数量**: ${(params.clocks as unknown[]).length}`,
              ...(result.warnings.length > 0 ? ['', '### 提示', ...result.warnings.map((w) => `- ${w}`)] : [])
            ].join('\n')
          }],
          details: result
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `SDC 生成失败：${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
          details: {}
        }
      }
    }
  })

  // ============================================================
  // 工具 8: run_logic_synthesis — Yosys 网表、面积和时序估算
  // ============================================================
  pi.registerTool({
    name: 'run_logic_synthesis',
    label: 'Run Logic Synthesis',
    description: '调用 Yosys 完成逻辑综合，输出门级 Verilog 网表、JSON 网表、日志和 Markdown 报告。无 Liberty 时报告通用单元数；提供 Liberty 时执行工艺映射并尝试解析面积和 ABC 延迟。提供 scenarioIds 时综合成功即自动把 PASS 登记到 scenario_hits.json（PPA 条款的 SYNTH 阶段验收证据）并重建验证态势；scenario_hits.json 由工具独占写入，禁止手工编辑。',
    promptSnippet: 'Run Yosys logic synthesis and generate netlist and reports',
    promptGuidelines: 'Pass SRAM blackbox views in libraryFiles, never behavioral/physical views. Report macro PPA separately from Yosys standard-cell area. In SYNTH phase, bind scenarioIds of intents anchored on synthesis-channel (PPA) clauses so acceptance evidence is auto-registered.',
    parameters: Type.Object({
      rtlFiles: Type.Optional(Type.Array(Type.String(), { description: 'RTL 文件列表；缺省时扫描工作区' })),
      libraryFiles: Type.Optional(Type.Array(Type.String(), { description: '宏/库 blackbox Verilog；使用 read_verilog -lib' })),
      topModule: Type.String({ description: '顶层模块名称' }),
      sdcFile: Type.Optional(Type.String({ description: 'SDC 文件路径' })),
      targetLibrary: Type.Optional(Type.String({ description: 'Liberty .lib 工艺库路径；缺省使用 MoonGlass 工艺库索引选定的默认库，未配置则执行通用综合' })),
      outputDir: Type.Optional(Type.String({ description: '输出目录，缺省为 imp/synthesis' })),
      outputName: Type.Optional(Type.String({ description: '输出文件名前缀，缺省为顶层模块名' })),
      scenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }), { description: '本次综合定向闭环的场景 ID（锚定 synthesis 通道 PPA 条款的意图场景）；综合成功且报告生成时自动登记 scenario_hits' })),
      effort: Type.Optional(Type.Union([
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high')
      ]))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const inputs = readRtlInputs(ctx.cwd)
      const requestedFiles = params.rtlFiles as string[] | undefined
      const rtlFiles = (requestedFiles?.length ? requestedFiles : inputs.designFiles)
        .map((file) => resolve(ctx.cwd, file))
      const requestedLibraries = params.libraryFiles as string[] | undefined
      const libraryFiles = (requestedLibraries ?? inputs.libraryFiles).map((file) => resolve(ctx.cwd, file))
      if (rtlFiles.length === 0) {
        return {
          content: [{ type: 'text', text: '综合失败：工作区中没有找到 RTL 文件' }],
          isError: true,
          details: {}
        }
      }

      try {
        const result = await runLogicSynthesis({
          rtlFiles,
          libraryFiles,
          topModule: params.topModule as string,
          outputDir: resolve(ctx.cwd, (params.outputDir as string | undefined) ?? 'imp/synthesis'),
          outputName: params.outputName as string | undefined,
          sdcFile: params.sdcFile ? resolve(ctx.cwd, params.sdcFile as string) : undefined,
          targetLibrary: params.targetLibrary ? resolve(ctx.cwd, params.targetLibrary as string) : undefined,
          effort: params.effort as 'low' | 'medium' | 'high' | undefined
        })
        // PPA 条款验收证据管线（与 run_simulation 同语义）：综合成功且报告生成时按 scenarioIds 自动登记
        // scenario_hits（passed=综合成功，证据=报告/网表路径，rtlHash 由 writeScenarioHits 自算），并重建验证态势
        const hits = writeScenarioHits(resolve(ctx.cwd), params.topModule as string, {
          scenarioIds: params.scenarioIds as string[] | undefined,
          passed: true,
          rtlFiles,
          evidence: [result.reportPath, result.netlistPath]
        })
        const report: string[] = []
        if (params.scenarioIds) {
          report.push('', '### Scenario 证据登记', '')
          if (hits.registered.length) report.push(`已自动登记 ${hits.registered.length} 个场景到 scenario_hits.json：${hits.registered.join('、')}`)
          for (const warning of hits.warnings) report.push(`⚠️ ${warning}`)
          const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
          report.push(rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次综合结果）：${rebuildError}` : '态势快照已自动重建，验证态势页刷新即可见')
        }
        return {
          content: [{
            type: 'text',
            text: [
              '## 逻辑综合完成',
              '',
              `**顶层模块**: ${result.topModule}`,
              `**目标库**: ${result.targetLibrary ?? '未使用（默认库不可用）'}`,
              `**门级网表**: ${result.netlistPath}`,
              `**综合报告**: ${result.reportPath}`,
              `**单元数量**: ${result.area.cells}`,
              `**面积**: ${result.area.value ?? '不可用'}（${result.area.message}）`,
              `**时序**: ${result.timing.delayNs !== undefined ? `${result.timing.delayNs} ns` : '不可用'}（${result.timing.message}）`,
              `**警告**: ${result.warnings.length}`,
              ...report
            ].join('\n')
          }],
          details: { ...result, scenarioHits: hits.registered }
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `逻辑综合失败：${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
          details: {}
        }
      }
    }
  })

  // ============================================================
  // 工具 9: run_cdc_check — 时钟域交叉（CDC）静态检查
  // ============================================================
  pi.registerTool({
    name: 'run_cdc_check',
    label: 'Run CDC Check',
    description: '对工作区 RTL 代码进行时钟域交叉（Clock Domain Crossing）静态分析。检测多时钟域设计、跨域信号路径，并检查是否存在标准同步器（2-flop / async FIFO）。输出 CDC 报告与修复建议。',
    promptSnippet: 'Run clock domain crossing analysis on the RTL design',
    promptGuidelines: 'Use run_cdc_check in multi-clock designs to find CDC issues. Always use 2-flop synchronizers for single-bit CDC and async FIFOs for multi-bit CDC.',
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: '扫描目录（缺省为工作区 rtl/）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const dir = resolve(ctx.cwd, (params.directory as string | undefined) ?? 'rtl')
      const files = collectRtlFiles(dir)

      if (files.length === 0) {
        return {
          content: [{ type: 'text', text: `工作目录 ${dir} 中未发现 RTL 文件。` }],
          isError: false, details: { clockDomains: [] }
        }
      }

      // ---- CDC 分析 ----
      const clockSignals = new Set<string>()
      const resetSignals = new Set<string>()
      const clockDomains = new Map<string, string[]>()
      const synchronizers: Array<{ clk: string; sig: string }> = []
      const potentialViolations: Array<{ fromClk: string; toClk: string; signal: string; line: number }> = []

      for (const file of files) {
        const code = readFileSync(file, 'utf-8')
        const lines = code.split(/\r?\n/)
        let currentClk = ''

        for (let ln = 0; ln < lines.length; ln++) {
          const t = lines[ln].trim()

          // 检测时钟和复位端口
          const portMatch = /^\s*(input|output|inout)\s+(wire\s+|reg\s+)?(\[.*?\]\s+)?(i_)?(clk|rst_n?|rst)\b/i.exec(t)
          if (portMatch) {
            const fullName = portMatch[4] ? portMatch[4] + portMatch[5] : portMatch[5]
            if (/clk/i.test(fullName)) clockSignals.add(fullName)
            if (/rst/i.test(fullName)) resetSignals.add(fullName)
          }

          // 检测 always @(posedge/negedge clk)
          const alwaysMatch = /always\s*@\s*\(\s*(posedge|negedge)\s+(\w+)/i.exec(t)
          if (alwaysMatch) {
            currentClk = alwaysMatch[2]
            clockSignals.add(currentClk)
            if (!clockDomains.has(currentClk)) clockDomains.set(currentClk, [])
            continue
          }

          if (currentClk) {
            // 检测 2-flop 同步器模式：两个 always 块中 r_sync_... <= r_sync_...
            const syncMatch = /^\s*r_sync_\w+\s*<=\s*r_sync_\w+/i.exec(t)
            if (syncMatch) {
              synchronizers.push({ clk: currentClk, sig: syncMatch[0].split('<=')[0].trim() })
            }

            // 检测寄存器赋值（r_ / o_ 前缀）
            const regMatch = /^\s*(r_\w+|o_\w+)\s*<=\s*/i.exec(t)
            if (regMatch) {
              clockDomains.get(currentClk)!.push(regMatch[1])
            }
          }
        }
      }

      // ---- 生成报告 ----
      const clkList = [...clockDomains.keys()]
      const isMultiClock = clockDomains.size > 1

      const report: string[] = [
        `## CDC 检查报告`,
        '',
        `**分析文件**: ${files.length} 个`,
        `**时钟域数量**: ${clockDomains.size}`,
        `**复位信号**: ${[...resetSignals].join(', ') || '无'}`,
        `**检测到同步器**: ${synchronizers.length} 个`,
        '',
      ]

      if (!isMultiClock) {
        report.push('✅ 单时钟域设计，无需 CDC 处理。')
      } else {
        report.push('### 时钟域分布', '')
        for (const [clk, regs] of clockDomains) {
          report.push(`- **${clk}**: ${regs.length} 个寄存器`)
        }
        report.push('')

        report.push('### 跨时钟域路径', '')
        for (let i = 0; i < clkList.length; i++) {
          for (let j = i + 1; j < clkList.length; j++) {
            const cross = `${clkList[i]} ↔ ${clkList[j]}`
            report.push(`- ${cross}`)
          }
        }
        report.push('')

        report.push('### CDC 修复建议', '')
        report.push('1. **单比特信号**: 使用 2-flop 同步器（命名规范 r_sync_*）')
        report.push('   ```verilog')
        report.push('   always @(posedge clk_dst) begin')
        report.push('     r_sync_a <= r_sync_b;')
        report.push('     r_sync_b <= src_signal;')
        report.push('     o_synced <= r_sync_a;')
        report.push('   end')
        report.push('   ```')
        report.push('2. **多比特/数据总线**: 使用异步 FIFO')
        report.push('3. **控制信号**: 使用 handshake 或 pulse synchronizer')
        report.push('4. **确认所有跨域路径都有明确同步策略**')
      }

      return {
        content: [{ type: 'text', text: report.join('\n') }],
        details: {
          files: files.length,
          clockDomains: [...clockDomains.keys()],
          clockCount: clockDomains.size,
          synchronizersFound: synchronizers.length,
          isMultiClock,
          resets: [...resetSignals]
        }
      }
    }
  })

  pi.registerTool({
    name: 'build_verification_intelligence',
    label: 'Build Verification Intelligence',
    description: '从需求/规格、RTL 结构事实和回归反馈生成 Requirement Model、Structural Model、Risk Register、Scenario Registry 与 Verification State。风险标记不等同于 RTL Bug。',
    promptSnippet: 'Build deterministic verification models before choosing verification scenarios',
    promptGuidelines: 'Exhaustive scenarios are a candidate pool, not a task list: circle the top real verification points yourself and register them via register_verification_intents. Do not invent RTL facts or generate arbitrary Cartesian products.',
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const artifacts = buildVerificationIntelligence(ctx.cwd)
      const state = artifacts.verificationState
      const top = state.scenarios.slice(0, 10)
      return {
        content: [{ type: 'text', text: `## Verification Intelligence\n\n- Requirement：${artifacts.requirementModel.requirements.length}\n- RTL Structural Fact：${artifacts.structuralModel.facts.length}\n- Risk Marker：${artifacts.risks.length}\n- Scenario：${state.scenarioCount}\n- Critical Open：${state.criticalOpen.length}\n- RTL Hash：${state.rtlHash}\n\n### 当前最高优先级\n${top.length ? top.map((item) => `- ${item.id} [${item.status}] priority=${item.priority}：${item.title}`).join('\n') : '- 未识别到 Scenario'}\n\n日常状态读取唯一入口（≤10KB 摘要）：${artifacts.paths.executionSummary}\n报告：${artifacts.paths.report}` }],
        details: { paths: artifacts.paths, scenarioCount: state.scenarioCount, criticalOpen: state.criticalOpen, topScenarios: top },
        isError: false
      }
    }
  })

  pi.registerTool({
    name: 'refine_verification_intents',
    label: 'Refine Verification Intents',
    description: '把优先级最高的 Verification Intent 的 objective/failureMode/passCriteria 改写为具体可证伪的表述（点名具体信号、具体失效反例、具体判定），并合并回 Intent 注册表与验证态势。',
    promptSnippet: 'Refine top verification intents into concrete falsifiable targets',
    promptGuidelines: 'Only refine top scenarios. Ground each refinement in the actual RTL object and spec; never invent signals or facts.',
    parameters: Type.Object({
      refinements: Type.Array(Type.Object({
        scenarioId: Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }),
        objective: Type.Optional(Type.String()),
        failureMode: Type.Optional(Type.String()),
        passCriteria: Type.Optional(Type.Array(Type.String())),
        rtlSignals: Type.Optional(Type.Array(Type.String(), { description: '点名的真实 RTL 信号；引擎校验存在性后并入 observationPoints' }))
      }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = refineVerificationIntents(ctx.cwd, params.refinements)
      return {
        content: [{ type: 'text', text: `## Intent 精炼\n\n- 更新：${result.updated.length}\n- 未找到：${result.missing.length}${result.missing.length ? `（${result.missing.join('、')}）` : ''}\n\n结果已写回 verification-intent-registry.json 与 verification-posture.json。` }],
        details: result,
        isError: false
      }
    }
  })

  pi.registerTool({
    name: 'register_verification_intents',
    label: 'Register Verification Intents',
    description: '登记 Agent 主导的验证意图：点名真实 RTL 信号、具体失效反例与具体判定标准，并锚定现有 riskIds / requirementIds。引擎校验锚点真实性与波段一致性，幻觉信号、不存在的 ID 或波段与锚定风险冲突会被拒绝；接受后生成 origin=AGENT_INTENT 的 Scenario（同分排序优先于引擎穷举候选）并自动重建验证态势。',
    promptSnippet: 'Register LLM-planned verification intents grounded in real signals and risks',
    promptGuidelines: 'Read risk-register.json, requirement-model.json and structural-model.json first. Every rtlSignal must be a real signal from the structural model. Declare wave consistently with anchored risks (corner requires a topic). Fix rejected anchors and re-register; never bypass by editing registry JSON.',
    parameters: Type.Object({
      intents: Type.Array(Type.Object({
        title: Type.String({ minLength: 1, description: '验证点标题' }),
        objective: Type.String({ minLength: 1, description: '可证伪验证目标' }),
        failureMode: Type.String({ minLength: 1, description: '具体失效反例' }),
        passCriteria: Type.Array(Type.String(), { minItems: 1, description: '具体判定标准' }),
        anchors: Type.Object({
          riskIds: Type.Array(Type.String(), { minItems: 1, description: 'risk-register.json 中现有的 Risk ID' }),
          requirementIds: Type.Array(Type.String(), { minItems: 1, description: 'requirement-model.json 中现有的 REQ/SPEC ID（断言级子条款 SPEC-xxx#a 或母条款均可）' }),
          rtlSignals: Type.Array(Type.String(), { minItems: 1, description: 'structural-model.json 中真实存在的信号，支持 module.signal 或裸信号名' })
        }, { description: '锚点：引擎逐项校验真实性，幻觉引用一律拒绝' }),
        recommendedMethod: Type.Union([Type.Literal('simulation'), Type.Literal('formal-candidate'), Type.Literal('static')], { description: '推荐验证方法' }),
        wave: Type.Optional(Type.Union([Type.Literal('smoke'), Type.Literal('basic'), Type.Literal('corner'), Type.Literal('signoff')], { description: '波段标签（缺省 basic）：smoke 冒烟不得锚定任何风险；basic 基础功能（规格条款 happy path）；corner 增补批（需 topic）；signoff 签核。锚定 formal-candidate 类风险（R02/R05/R19 等）不得声明 smoke/basic' })),
        topic: Type.Optional(Type.String({ description: 'W2 增补批主题名（仅 wave=corner 需要；引擎归一化后去重聚合，R01~R19 预定义主题为底座）' })),
        preconditions: Type.Optional(Type.Array(Type.String())),
        observationPoints: Type.Optional(Type.Array(Type.String()))
      }), { minItems: 1 })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: 'text', text: '正在校验锚点并登记验证意图…' }] })
      const result = registerVerificationIntents(ctx.cwd, params.intents)
      return {
        content: [{ type: 'text', text: `## 验证意图登记\n\n- 接受：${result.accepted.length}${result.accepted.length ? `（${result.accepted.join('、')}）` : ''}\n- 拒绝：${result.rejected.length}\n${result.rejected.map((item) => `  - ${item.title}：${item.reasons.join('；')}`).join('\n')}\n- 态势快照：${result.rebuilt ? '已自动重建，页面刷新即可见' : '未重建'}${result.warnings?.length ? `\n- 提醒：${result.warnings.join('；')}` : ''}\n\n被拒绝的锚点必须核对 risk-register / requirement-model / structural-model 后修正重登，不得绕过。` }],
        details: result,
        isError: result.rejected.length > 0
      }
    }
  })

  pi.registerTool({
    name: 'record_scenario_adjudication',
    label: 'Record Scenario Adjudication',
    description: '把判断类场景裁决（PLANNED/IMPLEMENTED/BLOCKED_BY_SPEC/WAIVED）写回 scenario-registry.json 并自动重新生成验证态势快照。执行派生状态（VERIFIED/FAILED/REACHED/NOT_REACHED/PARTIAL/FORMAL_PROVED/FORMAL_UNREACHABLE）只能由 run_simulation / run_formal_verification 的证据自动派生，不可宣布；WAIVED 要求 signoff-approvals.json 中已有 RR-WAIVER-<scenarioId> 具名审批。Agent 禁止用 write/edit 手改 verification/intelligence/ 下的机器 JSON。',
    promptSnippet: 'Record judgment-class scenario verdict and refresh the posture snapshot',
    promptGuidelines: 'Only PLANNED/IMPLEMENTED/BLOCKED_BY_SPEC/WAIVED are allowed. Execution-derived statuses come from simulation/formal evidence automatically. WAIVED requires an existing named user approval. Never invent scenario IDs.',
    parameters: Type.Object({
      adjudications: Type.Array(Type.Object({
        scenarioId: Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }),
        status: Type.Union([Type.Literal('PLANNED'), Type.Literal('IMPLEMENTED'), Type.Literal('BLOCKED_BY_SPEC'), Type.Literal('WAIVED')]),
        evidence: Type.Optional(Type.Array(Type.String()))
      }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: 'text', text: '正在写回场景裁决并重新生成验证态势快照…' }] })
      const result = recordScenarioAdjudication(ctx.cwd, params.adjudications)
      return {
        content: [{ type: 'text', text: `## 场景裁决写回\n\n- 更新：${result.updated.length}\n- 未找到：${result.missing.length}${result.missing.length ? `（${result.missing.join('、')}）` : ''}\n- 拒绝：${result.rejected.length}\n${result.rejected.map((item) => `  - ${item.scenarioId}：${item.reason}`).join('\n')}\n- 态势快照：${result.rebuilt ? '已重新生成，页面刷新即可见' : '未重建'}` }],
        details: result,
        isError: result.missing.length > 0 || result.rejected.length > 0
      }
    }
  })

  pi.registerTool({
    name: 'record_root_cause',
    label: 'Record Root Cause',
    description: '把 FAIL 排查的根因结论落盘到 verification/results/root-causes.json（证据区，非引擎产物）。rootCause 一句话（≤200 字）、fix 动作级（≤120 字）；同场景多条共存成链，refutedHypotheses 引用先前记录 id 做链式追溯。confirmed 根因在下次 rebuild 时自动挂到场景证据并进入签核包。',
    promptSnippet: 'Record the confirmed or refuted root cause for a failed scenario',
    promptGuidelines: 'Call when a run_simulation FAIL turns PASS, or when a hypothesis is confirmed/refuted during debugging. Keep rootCause to one sentence and fix to an action-level description. Never edit root-causes.json by hand.',
    parameters: Type.Object({
      scenarioId: Type.String({ pattern: '^SCN-[A-F0-9]{8}$', description: '关联的 Verification Scenario ID' }),
      hypothesis: Type.String({ minLength: 1, description: '根因假设' }),
      verdict: Type.Union([Type.Literal('confirmed'), Type.Literal('refuted'), Type.Literal('open')], { description: '本条假设的裁决' }),
      refutedHypotheses: Type.Array(Type.String(), { description: '本条证伪的先前根因记录 id（RC-*，链式追溯）；无则传空数组' }),
      failureSignature: Type.String({ description: '关联 diagnostic-control 失败指纹（run_simulation 返回的 12 位签名）；无则传空字符串' }),
      rootCause: Type.String({ maxLength: 200, description: '≤200 字，一句话确认根因；open/refuted 可为空' }),
      fix: Type.String({ maxLength: 120, description: '≤120 字，动作级修复描述（如"改 vbc_rate_ctrl 首拍 flush 锁存参数"）' }),
      evidence: Type.Array(Type.String(), { description: '证据路径（日志/波形/result.json），不是内容' })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const record = recordRootCause(ctx.cwd, params)
        const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
        return {
          content: [{ type: 'text', text: `## 根因登记\n\n- 记录 ID：${record.id}\n- 场景：${record.scenarioId}\n- 裁决：${record.verdict}\n- 落盘：verification/results/root-causes.json\n- ${rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次登记）：${rebuildError}` : '态势快照已自动重建；confirmed 根因已挂到场景证据并进入签核包'}` }],
          details: { record },
          isError: false
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `根因登记被拒绝：${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true }
      }
    }
  })

  pi.registerTool({
    name: 'review_verification_scenarios',
    label: 'Review Verification Scenarios',
    description: '确定性检查 Verification State 中关键 Scenario、回归证据和闭环状态。',
    promptSnippet: 'Review scenario closure using machine-readable verification state',
    promptGuidelines: 'Resolve critical scenarios with simulation, formal/static evidence, approved waiver, or explicit specification blocker.',
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = reviewScenarioClosure(ctx.cwd)
      const text = `## Scenario Closure Review\n\n**结论**：${result.passed ? '通过' : '拒绝签核'}\n\n${result.blockers.length ? `### 阻断项\n${result.blockers.map((item) => `- ${item}`).join('\n')}` : '无阻断项。'}${result.warnings.length ? `\n\n### 警告\n${result.warnings.map((item) => `- ${item}`).join('\n')}` : ''}`
      return { content: [{ type: 'text', text }], details: result, isError: !result.passed }
    }
  })

  pi.registerTool({
    name: 'run_formal_verification',
    label: 'Run Open-source Formal Verification',
    description: '使用 SymbiYosys + SMT solver 运行开源 Formal BMC、prove 或 cover。属性/harness 必须先写入 verification/formal，结果与反例 trace 自动归档。',
    promptSnippet: 'Run evidence-producing open-source formal verification',
    promptGuidelines: 'Use only properties grounded in SPEC_FACT or explicit invariants. Keep assumptions minimal and review them. A PASS proves only the configured property, depth/mode and model assumptions.',
    parameters: Type.Object({
      top: Type.String({ description: 'Formal harness 顶层模块名' }),
      rtlFiles: Type.Array(Type.String()),
      propertyFiles: Type.Array(Type.String()),
      mode: Type.Optional(Type.Union([Type.Literal('bmc'), Type.Literal('prove'), Type.Literal('cover')])),
      depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10000 })),
      engine: Type.Optional(Type.Union([Type.Literal('boolector'), Type.Literal('bitwuzla'), Type.Literal('z3')])),
      taskName: Type.Optional(Type.String()),
      scenarioId: Type.Optional(Type.String({ pattern: '^SCN-[A-F0-9]{8}$', description: '绑定的 Verification Scenario ID' })),
      obligation: Type.Optional(Type.Union([Type.Literal('required'), Type.Literal('supplemental')], { description: 'required 为唯一/强制关闭方法；supplemental 为已有仿真证据上的补强，缺省 supplemental' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: 'text', text: `正在运行 Formal ${params.mode ?? 'bmc'}：${params.top}` }] })
      const result = await runFormalVerification({ workspaceDir: ctx.cwd, ...params, signal })
      // 证据管线：Formal 结果落盘后自动重建验证态势；失败不影响本次结果返回
      const rebuildError = rebuildVerificationPosture(ctx.cwd)
      return { content: [{ type: 'text', text: `## Formal 验证结果\n\n- 状态：${result.status}\n- 义务：${result.obligation === 'required' ? '强制签核' : '补强证据'}\n- 模式：${result.mode}\n- 顶层：${result.top}\n- 引擎：${result.engine}\n- 深度：${result.depth}\n- 分类：${result.classification ?? '求解结果'}\n- 说明：${result.message}\n- 日志：${result.logPath}\n${result.compatibilityIssues?.length ? `- 兼容性问题：\n${result.compatibilityIssues.map((item) => `  - ${item.file}:${item.line} ${item.construct}：${item.message}`).join('\n')}` : ''}\n${result.traces.length ? `- 反例/见证：${result.traces.join(', ')}` : ''}\n- ${rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次 Formal 结果）：${rebuildError}` : '态势快照已自动重建，验证态势页刷新即可见'}` }], details: result, isError: ['ERROR', 'UNKNOWN'].includes(result.status) }
    }
  })

  pi.registerTool({
    name: 'register_verification_hypotheses',
    label: 'Register Verification Hypotheses',
    description: '登记受约束的验证推理。每个假设必须引用现有 Risk、RTL Object、Interaction Edge，并逐条区分 SPEC_FACT、RTL_FACT、INFERENCE、UNKNOWN。无依据组合会被拒绝。',
    promptSnippet: 'Register only evidence-grounded interaction hypotheses',
    promptGuidelines: 'Read feature-interaction-graph.json first. Never invent IDs. Mark uncertainty as UNKNOWN instead of converting it into a fact.',
    parameters: Type.Object({
      hypotheses: Type.Array(Type.Object({
        title: Type.String(),
        riskIds: Type.Array(Type.String()),
        rtlObjectIds: Type.Array(Type.String()),
        interactionEdgeIds: Type.Array(Type.String()),
        claims: Type.Array(Type.Object({ kind: Type.Union([Type.Literal('SPEC_FACT'), Type.Literal('RTL_FACT'), Type.Literal('INFERENCE'), Type.Literal('UNKNOWN')]), text: Type.String(), references: Type.Array(Type.String()) }))
      }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const results = registerVerificationHypotheses(ctx.cwd, params.hypotheses)
      const accepted = results.filter((item) => item.status === 'ACCEPTED')
      const rejected = results.filter((item) => item.status === 'REJECTED')
      return {
        content: [{ type: 'text', text: `## 受约束验证推理\n\n- 接受：${accepted.length}\n- 拒绝：${rejected.length}\n\n${rejected.map((item) => `- ${item.id} ${item.title}：${item.rejectionReasons.join('；')}`).join('\n') || '全部假设均通过引用约束。'}\n\n结果：verification/intelligence/verification-hypotheses.json` }],
        details: { accepted, rejected },
        isError: rejected.length > 0
      }
    }
  })

  pi.registerTool({
    name: 'select_next_verification_batch',
    label: 'Select Next Verification Batch',
    description: '根据已生成的 Scenario 风险、未闭环状态和覆盖率反馈，返回下一批可执行场景（v0.8.6：按聚类组返回执行批，同模块同 Oracle 域，一次 run_simulation 绑定全部 scenarioIds）。默认复用现有执行计划，只有明确 refresh 时才全量重建模型。',
    promptSnippet: 'Select the next evidence-driven scenario batch',
    promptGuidelines: 'Implement or reuse the named sequence and checkers. Bind scenarios via run_simulation(scenarioIds=...): scenario hits and the posture rebuild are automatic byproducts. Never hand-write scenario_hits.json.',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 12, description: '本批数量，缺省 3；小批执行便于及时反馈' })),
      budgetSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 86400, description: '本批预计执行预算；P0 强制场景不因预算被饿死' })),
      refresh: Type.Optional(Type.Boolean({ description: '是否先全量重建 Verification Intelligence；仅在规格、RTL 或回归证据变化后使用' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const planPath = resolve(ctx.cwd, 'verification', 'intelligence', 'scenario-execution-plan.json')
      let available: Array<{ scenarioId: string; sequence: string; iterations: number; budgetSeconds: number; mandatory?: boolean; reason: string; wave?: string; clusterId?: string }> = []
      let clusters: Array<{ clusterId: string; wave: string; module: string; oracleDomain: string; topic?: string; scenarioIds: string[]; executionBatches: string[][] }> = []
      let refreshed = Boolean(params.refresh)
      if (!refreshed && existsSync(planPath)) {
        try {
          const cached = JSON.parse(readFileSync(planPath, 'utf-8')) as { plans?: typeof available; clusters?: typeof clusters }
          available = cached.plans ?? []
          clusters = cached.clusters ?? []
        } catch { refreshed = true }
      } else if (!existsSync(planPath)) refreshed = true
      if (refreshed) {
        const rebuilt = buildVerificationIntelligence(ctx.cwd)
        available = rebuilt.verificationState.executionPlan
        clusters = rebuilt.verificationState.executionClusters
      }
      const limit = Number(params.limit ?? 3)
      // v0.8.6 聚类选批：有聚类视图且无显式预算约束时，返回当前 cluster 的下一个执行批
      let plans: typeof available = []
      let clusterNote = ''
      if (clusters.length > 0 && params.budgetSeconds === undefined) {
        const cluster = clusters[0]
        const batchIds = cluster.executionBatches[0] ?? []
        const byId = new Map(available.map((item) => [item.scenarioId, item]))
        plans = batchIds.map((id) => byId.get(id)).filter((item): item is (typeof available)[number] => Boolean(item)).slice(0, limit)
        clusterNote = `聚类组 ${cluster.clusterId}（模块 ${cluster.module} · ${cluster.oracleDomain}${cluster.topic ? ` · 主题「${cluster.topic}」` : ''}，波段 ${cluster.wave}）：本组场景同模块同 Oracle 域，写一个测试文件含 ${plans.length} 个 testcase，run_simulation(scenarioIds=[${plans.map((item) => item.scenarioId).join(', ')}]) 一次绑定全部 scenarioIds。`
      } else {
        let remainingBudget = Number(params.budgetSeconds ?? Number.POSITIVE_INFINITY)
        for (const plan of available) {
          if (plans.length >= limit) break
          if (!plan.mandatory && plan.budgetSeconds > remainingBudget) continue
          plans.push(plan)
          remainingBudget = Math.max(0, remainingBudget - plan.budgetSeconds)
        }
      }
      const explorationHistory = recordExplorationRound(ctx.cwd, plans.map((item) => item.scenarioId))
      return {
        content: [{ type: 'text', text: `## 下一批验证任务\n\n- 计划来源：${refreshed ? '已重建' : '增量复用'}\n- 本批数量：${plans.length}\n${clusterNote ? `\n${clusterNote}\n` : ''}\n${plans.map((item, index) => `${index + 1}. ${item.scenarioId} · ${item.sequence} · ${item.iterations} 次 / ${item.budgetSeconds}s${item.wave ? ` · ${item.wave}` : ''}\n   - ${item.reason}`).join('\n') || '当前没有待执行的 Scenario。'}\n\n机器可读计划：verification/intelligence/scenario-execution-plan.json` }],
        details: { plans, path: planPath, refreshed, requestedBudgetSeconds: params.budgetSeconds, saturation: explorationHistory.saturation },
        isError: false
      }
    }
  })

  pi.registerTool({
    name: 'review_verification_evidence',
    label: 'Review Verification Evidence',
    description: '独立读取验证源码、原始 result.json、JUnit、日志和覆盖率证据，检查测试有效性与签核条件；不得以 Agent 自述替代证据。',
    promptSnippet: 'Review raw verification evidence before declaring verification complete',
    promptGuidelines: 'Call after regressions and coverage collection. Resolve every blocking issue or record an approved waiver before claiming verification signoff.',
    parameters: Type.Object({
      lineThreshold: Type.Optional(Type.Number({ description: '行覆盖率门限，缺省 90' })),
      branchThreshold: Type.Optional(Type.Number({ description: '条件/分支覆盖率门限，缺省 85' })),
      functionalThreshold: Type.Optional(Type.Number({ description: '功能覆盖率门限，缺省 80' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const resultsDir = resolve(ctx.cwd, 'verification', 'results')
      const resultFiles = collectEvidenceFiles(resultsDir, (name) => name === 'result.json')
      const testFiles = collectEvidenceFiles(resolve(ctx.cwd, 'verification'), (name) => /^(?:test_.+|.+_test)\.py$/i.test(name))
      const blockers: string[] = []
      const warnings: string[] = []
      let minimumLine: number | undefined
      let minimumBranch: number | undefined
      let minimumFunctional: number | undefined
      let totalTests = 0
      let passedTests = 0
      let skippedTests = 0
      for (const file of resultFiles) {
        try {
          const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
          if (data.passed !== true) blockers.push(`回归未通过：${relative(ctx.cwd, file)}`)
          totalTests += Number(data.testsTotal ?? 0)
          passedTests += Number(data.testsPassed ?? 0)
          skippedTests += Number(data.testsSkipped ?? 0)
          const coverage = (data.coverage ?? {}) as Record<string, unknown>
          const values = {
            line: data.lineCoverage ?? coverage.lineCoverage,
            branch: data.branchCoverage ?? coverage.branchCoverage,
            functional: data.functionalCoverage ?? coverage.functionalCoverage
          }
          if (typeof values.line === 'number') minimumLine = Math.min(minimumLine ?? values.line, values.line)
          if (typeof values.branch === 'number') minimumBranch = Math.min(minimumBranch ?? values.branch, values.branch)
          if (typeof values.functional === 'number') minimumFunctional = Math.min(minimumFunctional ?? values.functional, values.functional)
          const requiredEvidence = data.functionalPassed !== undefined && data.rtlCoveragePassed !== undefined
            ? ['functionalCompileLogPath', 'functionalSimulationLogPath', 'rtlCompileLogPath', 'rtlSimulationLogPath', 'resultsXml', 'coverageDataPath', 'coverageReportPath']
            : ['compileLogPath', 'simulationLogPath', ...(data.framework === 'cocotb' ? ['resultsXml'] : [])]
          for (const evidence of requiredEvidence) {
            const path = typeof data[evidence] === 'string' ? data[evidence] as string : ''
            if (!path || !existsSync(path) || statSync(path).size === 0) blockers.push(`${relative(ctx.cwd, file)} 缺少有效 ${evidence}`)
          }
        } catch { blockers.push(`结果文件无法解析：${relative(ctx.cwd, file)}`) }
      }
      if (resultFiles.length === 0) blockers.push('未找到 verification/results/**/result.json')
      if (totalTests === 0) blockers.push('没有可核验的 Cocotb/JUnit 测试数量')
      if (skippedTests > 0) warnings.push(`${skippedTests} 个测试被跳过，签核前需说明原因`)
      const lineThreshold = Number(params.lineThreshold ?? 90)
      const branchThreshold = Number(params.branchThreshold ?? 85)
      const functionalThreshold = Number(params.functionalThreshold ?? 80)
      if (minimumLine === undefined) blockers.push('未找到 RTL 行覆盖率')
      else if (minimumLine < lineThreshold) blockers.push(`RTL 行覆盖率 ${minimumLine}% 低于 ${lineThreshold}%`)
      if (minimumBranch === undefined) blockers.push('未找到条件/分支覆盖率')
      else if (minimumBranch < branchThreshold) blockers.push(`条件/分支覆盖率 ${minimumBranch}% 低于 ${branchThreshold}%`)
      if (minimumFunctional === undefined) blockers.push('未找到功能覆盖率')
      else if (minimumFunctional < functionalThreshold) blockers.push(`功能覆盖率 ${minimumFunctional}% 低于 ${functionalThreshold}%`)
      const scenarioReview = reviewScenarioClosure(ctx.cwd)
      blockers.push(...scenarioReview.blockers.map((item) => `Scenario Closure：${item}`))
      warnings.push(...scenarioReview.warnings.map((item) => `Scenario Closure：${item}`))
      // 软强制（契约 §2.1，不阻断）：diagnostic-control 显示曾 FAIL、当前 scenario_hits 已 PASS、
      // 但 root-causes.json 无该场景 confirmed 记录 → 提醒补登记根因链
      const failedModules = new Set<string>()
      try {
        const diagnostic = JSON.parse(readFileSync(join(resultsDir, 'diagnostic-control.json'), 'utf-8')) as { attempts?: Array<{ topModule?: string; passed?: boolean }> }
        for (const attempt of diagnostic.attempts ?? []) if (attempt.passed === false && attempt.topModule) failedModules.add(attempt.topModule)
      } catch { /* 无诊断账本或损坏时不产生该警告 */ }
      const confirmedRootCauses = new Set<string>()
      try {
        const rootCauses = JSON.parse(readFileSync(join(resultsDir, 'root-causes.json'), 'utf-8')) as { records?: Array<{ scenarioId?: string; verdict?: string }> }
        for (const record of rootCauses.records ?? []) if (record.verdict === 'confirmed' && record.scenarioId) confirmedRootCauses.add(record.scenarioId)
      } catch { /* 无根因账本时按空集合处理 */ }
      if (failedModules.size) {
        for (const file of collectEvidenceFiles(resultsDir, (name) => name === 'scenario_hits.json')) {
          if (!failedModules.has(basename(dirname(file)))) continue
          try {
            const hits = JSON.parse(readFileSync(file, 'utf-8')) as { scenarios?: Array<{ id?: string; passed?: boolean }> }
            for (const scenario of hits.scenarios ?? []) {
              if (scenario.passed === true && scenario.id && !confirmedRootCauses.has(scenario.id)) {
                warnings.push(`场景 ${scenario.id} 曾 FAIL 后转 PASS，但 root-causes.json 无 confirmed 根因记录；请用 record_root_cause 补登记（含已证伪假设链）`)
              }
            }
          } catch { /* 单个 hits 文件损坏不阻断审查 */ }
        }
      }
      for (const file of testFiles) {
        const code = readFileSync(file, 'utf-8')
        if (!/@cocotb\.test/.test(code)) warnings.push(`${relative(ctx.cwd, file)} 未发现 @cocotb.test`)
        if (!/\b(assert|scoreboard|compare|expected|check)\b/i.test(code)) blockers.push(`${relative(ctx.cwd, file)} 未发现有效检查点/Scoreboard`)
      }
      const verdict = blockers.length === 0 ? (warnings.length === 0 ? 'passed' : 'conditional') : 'rejected'
      const review = { verdict, reviewedAt: new Date().toISOString(), evidence: { resultFiles: resultFiles.map((file) => relative(ctx.cwd, file)), testFiles: testFiles.map((file) => relative(ctx.cwd, file)), totalTests, passedTests, skippedTests }, coverage: { lineCoverage: minimumLine ?? null, branchCoverage: minimumBranch ?? null, functionalCoverage: minimumFunctional ?? null }, thresholds: { line: lineThreshold, branch: branchThreshold, functional: functionalThreshold }, blockers, warnings }
      mkdirSync(resultsDir, { recursive: true })
      const jsonPath = join(resultsDir, 'verification_signoff_review.json')
      const reportPath = join(resultsDir, 'verification_signoff_review.md')
      writeFileSync(jsonPath, JSON.stringify(review, null, 2), 'utf-8')
      writeFileSync(reportPath, `# 验证证据独立审查\n\n- 结论：${verdict === 'passed' ? '通过' : verdict === 'conditional' ? '有限通过' : '拒绝签核'}\n- 回归：${passedTests}/${totalTests}\n- 行覆盖率：${minimumLine ?? '暂无'}%\n- 条件/分支覆盖率：${minimumBranch ?? '暂无'}%\n- 功能覆盖率：${minimumFunctional ?? '暂无'}%\n\n## 阻断项\n${blockers.length ? blockers.map((item) => `- ${item}`).join('\n') : '- 无'}\n\n## 警告\n${warnings.length ? warnings.map((item) => `- ${item}`).join('\n') : '- 无'}\n`, 'utf-8')
      return { content: [{ type: 'text', text: `## 验证证据审查\n\n**结论**：${verdict === 'passed' ? '通过' : verdict === 'conditional' ? '有限通过' : '拒绝签核'}\n\n${blockers.length ? `### 阻断项\n${blockers.map((item) => `- ${item}`).join('\n')}` : '无阻断项。'}\n\n报告：${reportPath}` }], details: { ...review, jsonPath, reportPath }, isError: verdict === 'rejected' }
    }
  })
}
