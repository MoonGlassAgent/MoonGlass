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
import { createHash, randomBytes } from 'node:crypto'
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
import { runCocotbSimulation, runVerilatorSimulation, resolveMaxWaveformGB, parseVerilatorCoverageDetail } from './eda-bridge/simulation'
import { generateSdc, runLogicSynthesis } from './eda-bridge/synthesis'
import { runFormalVerification } from './eda-bridge/formal'
import { runDesignLint } from './eda-bridge/lint'
import { analyzeDeadLogic, writeDeadLogicReport } from './eda-bridge/dead-logic'
import { collectRtlFiles, readRtlInputs } from './eda-bridge/rtl-files'
import { buildVerificationIntelligence, recordExplorationRound, registerVerificationHypotheses, reviewScenarioClosure, refineVerificationIntents, recordScenarioAdjudication, registerVerificationIntents, recordRootCause, computeRtlHash, registerUtEscalation, retireUtEscalation, registerConfigSpace } from './verification-intelligence/engine.ts'
import { createRtlWriteGuard } from './rtl-write-guard.ts'

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
  /** 波形体积熔断留痕（C6 工具/插桩类）；仅在熔断触发或外部 TB 超限时写入 */
  waveformGuard?: WaveformGuardRecord
}

/** 波形体积熔断事件：classification 固定 C6 工具/插桩（与 verification-intelligence 的 CoverageHole 分类口径一致） */
interface WaveformGuardRecord {
  classification: 'C6_TOOL_INSTRUMENTATION'
  /** dump-stopped=cpp TB 内只停 dump；simulation-aborted=cocotb 超限终止仿真；uncontrolled-over-limit=外部 TB 超限未受控 */
  behavior: 'dump-stopped' | 'simulation-aborted' | 'uncontrolled-over-limit'
  detail: string
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

/** 失败日志归一化行（路径/时间/十六进制/大数字脱敏 + 错误关键词过滤），failureSignature 与 failureSummary 共用同一次归一化 */
function normalizeFailureLines(log: string): string[] {
  return log.split(/\r?\n/)
    .map((line) => line.replace(/[A-Z]:\\[^\s:]+/gi, '<path>').replace(/\b\d+(?:\.\d+)?\s*(?:ns|us|ms|s|cycles?)\b/gi, '<time>').replace(/\b0x[0-9a-f]+\b/gi, '<hex>').replace(/\b\d{4,}\b/g, '<number>').trim())
    .filter((line) => /error|fail|assert|mismatch|timeout|traceback|exception|fatal/i.test(line))
}

function failureSignature(log: string): string {
  const normalized = normalizeFailureLines(log).slice(-12).join('\n') || log.slice(-1200)
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
}

/** 失败摘要（方案 C 批 1 §3.3）：归一化后首个错误行，≤160 字硬截断；无错误行返回空串（调用方不写字段） */
function failureSummary(log: string): string {
  return (normalizeFailureLines(log)[0] ?? '').slice(0, 160)
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
  waveformGuard?: WaveformGuardRecord
}): DiagnosticControlState {
  const path = join(input.workspace, 'verification', 'results', 'diagnostic-control.json')
  let previous: DiagnosticControlState | undefined
  try { previous = JSON.parse(readFileSync(path, 'utf-8')) as DiagnosticControlState } catch { /* 首次执行 */ }
  const activeCase = `${input.topModule}::${input.testcase ?? 'all'}`
  const diagnosis = inferDiagnosticLevel(input.log, input.hasWaveform)
  if (input.waveformGuard) diagnosis.observations.push(`波形体积熔断（${input.waveformGuard.classification}）：${input.waveformGuard.detail}`)
  const attempt: DiagnosticAttempt = {
    id: `ATT-${Date.now()}`, topModule: input.topModule, testcase: input.testcase ?? 'all', passed: input.passed,
    createdAt: new Date().toISOString(), durationMs: input.durationMs, failureSignature: input.passed ? 'PASS' : failureSignature(input.log),
    rtlHash: filesHash(input.rtlFiles), testbenchHash: input.testDir ? filesHash(walkFiles(input.testDir, (file) => /\.(?:py|sv|v|cpp|json)$/i.test(file))) : '',
    diagnosticLevel: diagnosis.level, observations: diagnosis.observations, evidence: input.evidence.filter(Boolean),
    ...(input.waveformGuard ? { waveformGuard: input.waveformGuard } : {})
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

/** 证据通道（BUG-VERIF-BATCH-001 设计契约）：scenario_hits 条目按通道做闭环匹配；旧数据缺 channel 视为 'simulation' */
export type ScenarioEvidenceChannel = 'simulation' | 'static' | 'synthesis' | 'formal'

export interface ScenarioHitWriteInput {
  /** 显式场景 ID（来自 select_next_verification_batch 返回的批次），优先于 testcase 名解析 */
  scenarioIds?: string[]
  /** 用例名；含 scn_<8位hex> 标记时可解析出场景 ID */
  testcase?: string
  /** 场景 ID → 执行该场景的 cocotb 测试函数名（从本次 JUnit XML 解析）；拿不到的场景不传，不写空 */
  testNames?: Record<string, string>
  /**
   * 本次运行实际执行的全部测试函数名（JUnit XML 中非 skipped 的 testcase）。
   * BUG-VERIF-BIND-001：scenarioIds 路径的反向指针——单用例运行时该函数名会提升为条目的
   * 精确 testName；多用例运行时整组记入 boundTestcases（批次级绑定，审计可追溯）。
   */
  runTestcases?: string[]
  passed: boolean
  /** 证据通道（BUG-VERIF-BATCH-001）：缺省 'simulation'（兼容旧调用方）；静态工具传 'static'，综合工具传 'synthesis' */
  channel?: ScenarioEvidenceChannel
  /** 登记工具名（如 'run_verible_lint'）；提供时随条目写入，不给则不写 */
  tool?: string
  /** FAIL 时写入：失败日志归一化后首个错误行（≤160 字硬截断，方案 C 批 1 §3.3）；PASS 路径不写并清除旧值 */
  failureSummary?: string
  /** FAIL 时写入：与 diagnostic-control 同一算法的失败指纹（归一化 sha1 前 12 位） */
  failureSignature?: string
  rtlFiles: string[]
  evidence: string[]
}

export interface ScenarioHitWriteResult {
  registered: string[]
  warnings: string[]
}

/**
 * 把执行结果自动登记到 verification/results/<topModule>/scenario_hits.json（合并写）。
 * 这是 scenario_hits.json 的唯一写入入口：PASS/FAIL 都登记（失败同样是证据），
 * Agent 禁止手写该文件。导出以便 smoke 直接测试合并逻辑。
 * rtlHash 必须使用引擎统一口径（computeRtlHash，与新鲜度判定同一哈希空间）；
 * 引擎不可用时回退 filesHash 并在 warnings 中说明（该回退的哈希不参与新鲜度判定）。
 * BUG-VERIF-BATCH-001：条目始终写 channel（缺省 'simulation'，旧数据读取侧归一），
 * 静态/综合工具经 channel='static'/'synthesis' 登记，引擎按通道做闭环匹配。
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
  // 证据通道归一：缺省 'simulation'（旧调用方/旧数据同口径），始终随条目写入
  const channel = input.channel ?? 'simulation'
  for (const id of scenarioIds) {
    const previous = byId.get(id)
    // testName：把执行该场景的 cocotb 测试函数名记入条目，供 FileService 映射 TEST ID；
    // 仅在拿到非空名字时写入（不写空字段），旧数据无此字段时读取侧回退 evidence 解析。
    // BUG-VERIF-BIND-001：单用例运行（runTestcases 恰好一个）时把该用例提升为所有显式绑定
    // 场景的精确 testName；多用例运行时整组记入 boundTestcases 并标注 boundBy=scenarioIds。
    const preciseTestName = input.testNames?.[id] ?? (input.runTestcases?.length === 1 ? input.runTestcases[0] : undefined)
    const runTestcases = input.runTestcases ?? []
    const boundTestcases = [...new Set([...((previous?.boundTestcases as string[] | undefined) ?? []), ...runTestcases])]
    const entry: Record<string, unknown> = {
      ...previous,
      id,
      reached: true,
      passed: input.passed,
      channel,
      reachCount: Number(previous?.reachCount ?? 0) + 1,
      rtlHash,
      evidence: [...new Set([...((previous?.evidence as string[] | undefined) ?? []), ...evidence])],
      // BUG-VERIF-BATCH-001：登记工具名仅给了才写（合并且保留旧值语义与其余字段一致）
      ...(typeof input.tool === 'string' && input.tool ? { tool: input.tool } : {}),
      ...(typeof preciseTestName === 'string' && preciseTestName ? { testName: preciseTestName } : {}),
      ...(boundTestcases.length > 0 ? { boundTestcases, boundBy: preciseTestName ? 'testcase-name' : 'scenarioIds' } : {}),
      generatedAt: new Date().toISOString()
    }
    // 方案 C 批 1（§3.3）：FAIL 登记携带失败摘要/指纹（供 UI 显示"为什么失败"）；
    // PASS 路径不写——并清掉上一次 FAIL 留下的旧字段，避免通过后的场景仍挂陈旧失败信息
    if (input.passed) {
      delete entry.failureSummary
      delete entry.failureSignature
    } else if (typeof input.failureSummary === 'string' && input.failureSummary) {
      entry.failureSummary = input.failureSummary
      if (typeof input.failureSignature === 'string' && input.failureSignature) entry.failureSignature = input.failureSignature
    }
    byId.set(id, entry)
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

// ---- 验证运行循环决策账本（VERIF-RUN-LOOP 批 3 §9.2；schema 与主进程 decision-ledger.ts 同源） ----

interface RunLoopDecisionRecord {
  id: string
  createdAt: string
  source: 'rule' | 'llm' | 'human'
  trigger: string
  action: { kind: 'derived' | 'custom'; actionId: string | null; prompt: string; expectedOutput: string; stopCriteria: string }
  rationale: string
  evidenceRefs: string[]
  status: 'proposed' | 'approved' | 'rejected' | 'executed' | 'superseded'
  outcome: 'advanced' | 'no-progress' | 'failed' | null
}

/** 决策账本滚动上限（§9.2：≤100 条，新在前） */
const RUN_LOOP_DECISION_LEDGER_LIMIT = 100

/**
 * 决策账本追加（追加式、新在前、原子写）：trigger='user-instruction'（工程师明确指示）
 * 登记为 source='human' 且直接 approved（§3.3 工程师指令不审批）；其余 LLM 提案为
 * source='llm'、status='proposed'，待人审批（顾问模式默认）。主进程读取方做缺字段归一。
 */
function appendRunLoopDecisionLedger(workspace: string, input: {
  source: 'llm' | 'human'
  trigger: string
  action: { kind: 'derived' | 'custom'; actionId: string | null; prompt: string; expectedOutput: string; stopCriteria: string }
  rationale: string
  evidenceRefs: string[]
}): RunLoopDecisionRecord {
  const ledgerPath = join(workspace, 'verification', 'results', 'decision-ledger.json')
  let existing: Array<{ id?: unknown }> = []
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { decisions?: unknown }
    if (Array.isArray(parsed.decisions)) existing = parsed.decisions as Array<{ id?: unknown }>
  } catch { /* 缺文件/损坏按空账本起步，由主进程读取方归一 */ }
  const existingIds = new Set(existing.map((item) => String(item?.id ?? '')))
  let id = ''
  do {
    id = `DEC-${randomBytes(4).toString('hex').toUpperCase()}`
  } while (existingIds.has(id))
  const record: RunLoopDecisionRecord = {
    id,
    createdAt: new Date().toISOString(),
    source: input.source,
    trigger: input.trigger,
    action: input.action,
    rationale: input.rationale,
    evidenceRefs: input.evidenceRefs,
    status: input.source === 'human' ? 'approved' : 'proposed',
    outcome: null
  }
  writeJsonAtomic(ledgerPath, { version: 1, decisions: [record, ...existing].slice(0, RUN_LOOP_DECISION_LEDGER_LIMIT) })
  return record
}

// ---- 验证长程循环"战略层"经验账本（批次/修复会话间传递可复用经验；schema 与主进程 experience-notes.ts 同源） ----

interface ExperienceNoteRecord {
  id: string
  text: string
  tags: string[]
  source: string
  createdAt: string
}

/** 经验账本滚动上限（契约：≤50 条，新在前） */
const EXPERIENCE_NOTES_LIMIT = 50
/** 经验正文长度上限（契约：≤200 字，超出截断） */
const EXPERIENCE_NOTE_TEXT_MAX = 200
/** 经验标签数量上限（契约：≤5 个） */
const EXPERIENCE_NOTE_TAGS_MAX = 5
/** 单个经验标签长度上限（契约：≤24 字，超出截断） */
const EXPERIENCE_NOTE_TAG_MAX = 24

/**
 * 经验账本追加（追加式、新在前、原子写、同 text+tags 幂等复用 id）：
 * 桥接目录无法 import 主进程模块，落盘口径与 src/main/services/experience-notes.ts 逐字一致。
 */
function appendExperienceNoteLedger(workspace: string, input: { text: string; tags?: string[]; source: string }): ExperienceNoteRecord {
  const text = input.text.trim().slice(0, EXPERIENCE_NOTE_TEXT_MAX)
  if (!text) throw new Error('经验正文（text）不能为空')
  const tags = (input.tags ?? [])
    .map((tag) => tag.trim().slice(0, EXPERIENCE_NOTE_TAG_MAX))
    .filter((tag) => tag.length > 0)
    .slice(0, EXPERIENCE_NOTE_TAGS_MAX)
  const ledgerPath = join(workspace, 'verification', 'results', 'experience-notes.json')
  let existing: ExperienceNoteRecord[] = []
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { notes?: unknown }
    if (Array.isArray(parsed.notes)) {
      existing = parsed.notes
        .map((item) => {
          if (typeof item !== 'object' || item === null) return null
          const note = item as Record<string, unknown>
          return {
            id: String(note.id ?? ''),
            text: String(note.text ?? ''),
            tags: Array.isArray(note.tags) ? note.tags.map(String) : [],
            source: String(note.source ?? ''),
            createdAt: String(note.createdAt ?? '')
          }
        })
        .filter((item): item is ExperienceNoteRecord => item !== null)
        .slice(0, EXPERIENCE_NOTES_LIMIT)
    }
  } catch { /* 缺文件/损坏按空账本起步，由主进程读取方归一 */ }
  const identity = JSON.stringify({ text, tags })
  const reused = existing.find((note) => JSON.stringify({ text: note.text, tags: note.tags }) === identity)
  let record: ExperienceNoteRecord
  if (reused) {
    record = { ...reused, createdAt: new Date().toISOString() }
  } else {
    const existingIds = new Set(existing.map((item) => item.id))
    let id = ''
    do {
      id = `EXP-${randomBytes(4).toString('hex').toUpperCase()}`
    } while (existingIds.has(id))
    record = { id, text, tags, source: input.source, createdAt: new Date().toISOString() }
  }
  writeJsonAtomic(ledgerPath, { version: 1, generatedAt: record.createdAt, notes: [record, ...existing.filter((item) => item.id !== record.id)].slice(0, EXPERIENCE_NOTES_LIMIT) })
  return record
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
// 端口方向行：方向后先跳过 net/data-type/signedness 关键字（wire/reg/logic/bit/tri/signed/unsigned），
// 再取 packed 维度，最后才是端口名。修复缺陷：原正则 `(\[.*?\])?` 失配后 `(\w+)` 会把
// `input wire en` 中的 `wire` 误当作端口名，导致 generate_tb 驱动不存在的 top->wire。
const PORT_DIR = /^\s*(input|output|inout)\s+(?:(?:wire|reg|logic|bit|tri|signed|unsigned)\s+)*((?:\[[^\]]*\]\s*)*)(\w+)/
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
  // M4 §5.4 RTL 写保护（尽力拦截层，非硬保证）：修复窗口内拦截非修复会话
  // 对 rtl/ 的 write/edit 与可检出的 bash 改写；绕过拦截的变更由 rtlHash
  // 失鲜兜底 + 主进程事后审计（前后快照 diff）覆盖。详见 rtl-write-guard.ts。
  pi.on('tool_call', createRtlWriteGuard(() => process.cwd()))

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
    description: '执行 RTL Lint。缺省按 design.json/filelist.f 对全设计进行 Verilator 联合 Lint 与顶层 elaboration；指定 filePath 时只做单文件快速检查。全设计检查且提供 scenarioIds 时，把本次检查结果作为这些静态通道场景的执行证据登记到 scenario_hits.json（channel=static，PASS/FAIL 都登记）并重建验证态势；单文件快速检查不登记。',
    promptSnippet: 'Run full-design RTL lint/elaboration or a fast single-file lint',
    promptGuidelines: 'Use file scope while editing. Before declaring RTL complete, omit filePath and run full-design lint/elaboration; a single-file PASS is never completion evidence. For batches from select_next_verification_batch whose scenarios are static-channel (method=static), pass their scenarioIds on the full-design run so the lint result is registered as scenario execution evidence.',
    parameters: Type.Object({
      filePath: Type.Optional(Type.String({ description: '可选：目标文件路径。省略时检查完整设计并 elaboration 顶层' })),
      rulesFile: Type.Optional(Type.String({ description: 'Verible 规则配置文件路径（可选，仅 verible 引擎生效）' })),
      autofix: Type.Optional(Type.Boolean({ description: '是否启用 autofix（仅 verible 支持，会就地修改文件）' })),
      scenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }), { description: '本次全设计检查定向闭环的静态通道场景 ID；提供时把本次检查结果作为这些场景的执行证据登记到 scenario_hits.json（channel=static），单文件快速检查不提供' }))
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
      let designTopModule: string | undefined
      let designFiles: string[] = []
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
        designTopModule = inputs.topModule
        designFiles = inputs.designFiles
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

      // BUG-VERIF-BATCH-001：静态通道场景证据登记——passed = 全设计检查 errors === 0；
      // 仅全设计检查（单文件快速检查不构成场景完成证据）且提供 scenarioIds 时登记（channel=static），
      // 检查报告落盘 rtlqa/lint/ 作为证据（引擎校验证据文件必须真实存在），rtlHash 由 writeScenarioHits 自算，
      // 登记后重建验证态势；未提供 scenarioIds 时行为与现状完全一致
      let scenarioHitsRegistered: string[] = []
      if (!filePath && params.scenarioIds) {
        if (designTopModule) {
          const lintReportDir = join(resolve(ctx.cwd), 'rtlqa', 'lint')
          mkdirSync(lintReportDir, { recursive: true })
          const lintReportJson = join(lintReportDir, 'lint_report.json')
          writeJsonAtomic(lintReportJson, {
            version: 1, generatedAt: new Date().toISOString(), engine: result.engine, target,
            passed, errorCount, warningCount, errors: result.errors, warnings: result.warnings
          })
          const lintReportMd = join(lintReportDir, 'lint_report.md')
          writeFileSync(lintReportMd, report.join('\n'), 'utf-8')
          const hits = writeScenarioHits(resolve(ctx.cwd), designTopModule, {
            scenarioIds: params.scenarioIds as string[] | undefined,
            passed,
            channel: 'static',
            tool: 'run_verible_lint',
            rtlFiles: designFiles,
            evidence: [lintReportJson, lintReportMd]
          })
          scenarioHitsRegistered = hits.registered
          report.push('', '### Scenario 证据登记', '')
          if (hits.registered.length) report.push(`已自动登记 ${hits.registered.length} 个场景到 scenario_hits.json：${hits.registered.join('、')}`)
          for (const warning of hits.warnings) report.push(`⚠️ ${warning}`)
          const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
          report.push(rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次 Lint 结果）：${rebuildError}` : '态势快照已自动重建，验证态势页刷新即可见')
        } else {
          report.push('', '### Scenario 证据登记', '', '⚠️ rtl/design.json 未声明顶层模块，无法定位 scenario_hits.json，跳过静态证据登记（请在 design.json 补 topModule 后重试）')
        }
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
          autofixed: autofix && result.fixedCode !== null,
          scenarioHits: scenarioHitsRegistered
        }
      }
    }
  })

  // ============================================================
  // 工具 1.5: check_dead_logic — RTL 无驱动/无负载（死逻辑）检查
  // （用户需求 2026-09-28：死代码影响验证回归，RTL 阶段优先清理；
  //   涉及架构契约的处置必须经工程师裁决，禁止 Agent 自行删除）
  // ============================================================
  pi.registerTool({
    name: 'check_dead_logic',
    label: 'Check Dead Logic',
    description: '基于 slang elaborated AST 按模块统计每个信号的驱动与负载，检出 undriven（有负载无驱动）/ unused（有驱动无负载）/ dead（两者兼有）三类死逻辑。报告写入 rtlqa/lint/dead_logic_report.json 与 dead_logic_report.md；internal 项可直接清理，spec-anchored 项（命中 docs/03_design 架构文档或属顶层端口）必须经 request_user_decision 请工程师裁决并写回报告 adjudications。提供 scenarioIds 时，把本次检查结果作为这些静态通道场景的执行证据登记到 scenario_hits.json（channel=static，PASS/FAIL 都登记，passed=无未裁决 undriven 项）并重建验证态势。',
    promptSnippet: 'Check RTL for undriven/unused (dead) logic via slang elaborated AST',
    promptGuidelines: 'Run after full-design lint/elaboration. Clean up internal items directly. For spec-anchored items never delete on your own: adjudicate each via request_user_decision (remove / keep with rationale / mark TBD) and record every decision into adjudications of rtlqa/lint/dead_logic_report.json. Re-run this tool after cleanup; prior adjudications for still-present items are carried over automatically. For batches from select_next_verification_batch whose scenarios are static-channel (method=static), pass their scenarioIds so the check result is registered as scenario execution evidence.',
    parameters: Type.Object({
      topModule: Type.Optional(Type.String({ description: '顶层模块名（可选，缺省取 rtl/design.json 的 topModule）' })),
      scenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }), { description: '本次检查定向闭环的静态通道场景 ID；提供时把本次检查结果作为这些场景的执行证据登记到 scenario_hits.json（channel=static）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const inputs = readRtlInputs(ctx.cwd)
      if (inputs.designFiles.length === 0) throw new Error('工作区没有可检查的设计 RTL')
      try {
        const report = await analyzeDeadLogic({
          workspace: ctx.cwd,
          files: inputs.designFiles,
          libraryFiles: inputs.libraryFiles,
          includeDirs: inputs.includeDirs,
          defines: inputs.defines,
          topModule: (params.topModule as string | undefined) ?? inputs.topModule
        })
        const { jsonPath, mdPath } = writeDeadLogicReport(ctx.cwd, report)
        const adjudicated = new Set(report.adjudications.map((item) => item.key))
        const pending = report.issues.filter((issue) => issue.classification === 'spec-anchored' && !adjudicated.has(`${issue.module}.${issue.signal}`))

        const lines = [
          `## 死逻辑检查 — 完整设计（${inputs.designFiles.length} 个文件，顶层 ${(params.topModule as string | undefined) ?? inputs.topModule ?? '自动识别'}）`,
          `**引擎**: slang ${report.tool.version}（elaborated AST，generate 未选中分支天然排除）`,
          `**结果**: ${report.issues.length === 0 ? '✅ 无死逻辑' : `⚠️ ${report.issues.length} 项`}（undriven ${report.stats.undriven} / unused ${report.stats.unused} / dead ${report.stats.dead}）`,
          `**分类**: internal（可直接清理）${report.stats.internal} 项；spec-anchored（需工程师裁决）${report.stats.specAnchored} 项，其中未裁决 ${pending.length} 项`,
          `**报告**: ${relative(ctx.cwd, jsonPath)} / ${relative(ctx.cwd, mdPath)}`,
          ''
        ]
        if (report.issues.length > 0) {
          lines.push('### 问题列表（前 ' + MAX_ISSUES_IN_REPORT + ' 条）')
          for (const issue of report.issues.slice(0, MAX_ISSUES_IN_REPORT)) {
            const anchor = issue.topLevelPort ? '顶层端口' : issue.specAnchor ?? ''
            lines.push(`- ${issue.file}:${issue.line} \`${issue.module}.${issue.signal}\` — ${issue.kind} / ${issue.classification}${anchor ? `（${anchor}）` : ''}：${issue.suggestion}`)
          }
          lines.push('')
        }
        if (pending.length > 0) {
          lines.push(`### 待工程师裁决（${pending.length} 项 spec-anchored）`)
          lines.push('逐项调用 request_user_decision 请工程师选择：删除 / 保留并说明理由 / 标注 TBD；')
          lines.push('裁决结果追加到 rtlqa/lint/dead_logic_report.json 的 adjudications（key 为 "<模块>.<信号>"，decision ∈ remove/keep/tbd，rationale 必填）。')
          lines.push('裁决涉及接口/寄存器/架构契约变更时，先同步更新 docs/03_design/ 对应文档再改 RTL。')
        } else if (report.stats.internal > 0) {
          lines.push('internal 项属死代码，直接清理（连同只服务于死信号的驱动/负载逻辑），清理后复跑本工具确认清零。')
        }

        // BUG-VERIF-BATCH-001：静态通道场景证据登记——passed = 无未裁决的 undriven 项
        // （报告里 kind=undriven 且未被 adjudications 覆盖的计数为 0；unused/dead 不计入口径），
        // channel=static，证据=rtlqa/lint/dead_logic_report.json/.md，rtlHash 由 writeScenarioHits 自算，
        // 登记后重建验证态势；仅在提供 scenarioIds 时登记，未提供时行为与现状完全一致
        let scenarioHitsRegistered: string[] = []
        if (params.scenarioIds) {
          const deadLogicTop = (params.topModule as string | undefined) ?? inputs.topModule
          if (deadLogicTop) {
            const undrivenUnadjudicated = report.issues.filter((issue) => issue.kind === 'undriven' && !adjudicated.has(`${issue.module}.${issue.signal}`))
            const hits = writeScenarioHits(resolve(ctx.cwd), deadLogicTop, {
              scenarioIds: params.scenarioIds as string[] | undefined,
              passed: undrivenUnadjudicated.length === 0,
              channel: 'static',
              tool: 'check_dead_logic',
              rtlFiles: inputs.designFiles,
              evidence: [jsonPath, mdPath]
            })
            scenarioHitsRegistered = hits.registered
            lines.push('', '### Scenario 证据登记', '')
            if (hits.registered.length) lines.push(`已自动登记 ${hits.registered.length} 个场景到 scenario_hits.json：${hits.registered.join('、')}（passed=${undrivenUnadjudicated.length === 0}，未裁决 undriven ${undrivenUnadjudicated.length} 项）`)
            for (const warning of hits.warnings) lines.push(`⚠️ ${warning}`)
            const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
            lines.push(rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次检查结果）：${rebuildError}` : '态势快照已自动重建，验证态势页刷新即可见')
          } else {
            lines.push('', '### Scenario 证据登记', '', '⚠️ 未提供 topModule 且 rtl/design.json 未声明顶层模块，无法定位 scenario_hits.json，跳过静态证据登记')
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: {
            engine: 'slang-ast',
            issueCount: report.issues.length,
            undriven: report.stats.undriven,
            unused: report.stats.unused,
            dead: report.stats.dead,
            specAnchored: report.stats.specAnchored,
            internal: report.stats.internal,
            pendingAdjudication: pending.length,
            reportPath: relative(ctx.cwd, jsonPath),
            issues: report.issues.slice(0, MAX_ISSUES_IN_REPORT),
            scenarioHits: scenarioHitsRegistered
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `死逻辑检查失败: ${message}` }],
          isError: true,
          details: {}
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
    description: '使用 Yosys 对 RTL 文件进行可综合性检查，包括语法解析、层次化检查和逻辑综合可行性。返回是否可综合、问题列表和资源估算（cells/wires）。提供 scenarioIds 时，把本次检查结果作为这些静态通道场景的执行证据登记到 scenario_hits.json（channel=static，PASS/FAIL 都登记，passed=检查通过）并重建验证态势。',
    promptSnippet: 'Check if RTL code is synthesizable using Yosys',
    promptGuidelines: 'After lint, pass design files as rtlFiles and SRAM blackbox views as libraryFiles. Never pass behavioral or physical macro views to Yosys synthesis. For batches from select_next_verification_batch whose scenarios are static-channel (method=static), pass their scenarioIds so the check result is registered as scenario execution evidence.',
    parameters: Type.Object({
      rtlFiles: Type.Array(Type.String(), { description: '需要检查的 RTL 文件路径列表' }),
      libraryFiles: Type.Optional(Type.Array(Type.String(), { description: '宏/库 blackbox Verilog；使用 read_verilog -lib' })),
      topModule: Type.Optional(Type.String({ description: '顶层模块名称（可选，缺省自动识别；提供 scenarioIds 登记证据时必填）' })),
      scenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }), { description: '本次检查定向闭环的静态通道场景 ID；提供时把本次检查结果作为这些场景的执行证据登记到 scenario_hits.json（channel=static）' }))
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

        // BUG-VERIF-BATCH-001：静态通道场景证据登记——passed = 可综合检查通过（无 error 级问题），
        // channel=static；检查报告落盘 rtlqa/synthesis/ 作为证据（引擎校验证据文件必须真实存在），
        // rtlHash 由 writeScenarioHits 自算，登记后重建验证态势；
        // 仅在提供 scenarioIds 时登记，未提供时行为与现状完全一致
        let scenarioHitsRegistered: string[] = []
        if (params.scenarioIds) {
          if (topModule) {
            const synthReportDir = join(resolve(ctx.cwd), 'rtlqa', 'synthesis')
            mkdirSync(synthReportDir, { recursive: true })
            const synthReportJson = join(synthReportDir, 'synthesizability_report.json')
            writeJsonAtomic(synthReportJson, {
              version: 1, generatedAt: new Date().toISOString(), topModule,
              rtlFiles, libraryFiles,
              synthesizable: result.synthesizable, errorCount, warningCount,
              issues: result.issues, cells: result.cells, wires: result.wires
            })
            const synthReportMd = join(synthReportDir, 'synthesizability_report.md')
            writeFileSync(synthReportMd, report.join('\n'), 'utf-8')
            const hits = writeScenarioHits(resolve(ctx.cwd), topModule, {
              scenarioIds: params.scenarioIds as string[] | undefined,
              passed: result.synthesizable,
              channel: 'static',
              tool: 'check_synthesizability',
              rtlFiles,
              evidence: [synthReportJson, synthReportMd]
            })
            scenarioHitsRegistered = hits.registered
            report.push('', '### Scenario 证据登记', '')
            if (hits.registered.length) report.push(`已自动登记 ${hits.registered.length} 个场景到 scenario_hits.json：${hits.registered.join('、')}`)
            for (const warning of hits.warnings) report.push(`⚠️ ${warning}`)
            const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
            report.push(rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次检查结果）：${rebuildError}` : '态势快照已自动重建，验证态势页刷新即可见')
          } else {
            report.push('', '### Scenario 证据登记', '', '⚠️ 未提供 topModule（自动识别无法定位 scenario_hits.json），跳过静态证据登记；请显式传 topModule 后重试')
          }
        }

        return {
          content: [{ type: 'text', text: report.join('\n') }],
          details: {
            synthesizable: result.synthesizable,
            errorCount,
            warningCount,
            cells: result.cells,
            wires: result.wires,
            issues: result.issues.slice(0, MAX_ISSUES_IN_REPORT),
            scenarioHits: scenarioHitsRegistered
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

      // [MOONGLASS_AUTO_STIMULUS] 激励端口：除时钟/复位外的全部输入。
      // 生成 TB 缺省带 xorshift32 伪随机激励，避免"空转 TB"导致 if/case 分支、
      // 条件表达式与翻转天然不可达、行/条件覆盖率虚低；定向测试可由 Agent 替换为具体激励。
      const stimulusPorts = info.ports.filter(
        (p) => p.direction === 'input' && p.name !== clockName && p.name !== resetName
      )
      const stimulusMask = (width: number): string => {
        const clamped = Math.min(Math.max(width, 1), 32)
        return clamped >= 32 ? '0xFFFFFFFFu' : `0x${((1 << clamped) - 1).toString(16).toUpperCase()}u`
      }
      const stimulusInitLines = stimulusPorts.map((p) => `  top->${p.name} = 0;`).join('\n')
      const stimulusDriveLines = stimulusPorts
        .map((p) => `    mg_lfsr = mg_xorshift32(mg_lfsr);\n    top->${p.name} = mg_lfsr & ${stimulusMask(p.width)};`)
        .join('\n')

      const tbCode = `// ============================================================
// ${baseName} Verilator Testbench
// 自动生成时间: ${new Date().toISOString()}
// 基于: ${rtlFile}
// ============================================================

#include <verilated.h>
#include <cstdint>
#include <cstdlib>
#include "${vBase}.h"

${trace ? '#include <verilated_vcd_c.h>\n#include <cstdio>\n#include <fstream>' : ''}

vluint64_t main_time = 0;
double sc_time_stamp() { return main_time; }

// [MOONGLASS_AUTO_STIMULUS] xorshift32 伪随机激励源；可用环境变量 MOONGLASS_STIM_SEED 固定种子复现
static inline uint32_t mg_xorshift32(uint32_t s) {
  s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s;
}

int main(int argc, char** argv) {
  Verilated::commandArgs(argc, argv);
  Verilated::traceEverOn(${trace ? 'true' : 'false'});

  // 实例化 DUT
  ${vBase}* top = new ${vBase};

${trace ? `  // 波形追踪
  VerilatedVcdC* tfp = nullptr;
  tfp = new VerilatedVcdC;
  top->trace(tfp, 99);
  tfp->open("${baseName}.vcd");

  // [MOONGLASS_WAVEFORM_GUARD] 波形体积熔断（资源保护，刻意区别于 wall-clock 超时：
  // 不设无工程依据的仿真时间上限；此处只防超巨波形写爆磁盘）。
  // 每 mg_wave_check_cycles 个周期 stat 一次波形文件，超过阈值只关闭 dump，仿真继续跑完。
  const char* mg_limit_env = getenv("MOONGLASS_MAX_WAVEFORM_GB");
  const double mg_wave_limit_bytes = (mg_limit_env && atof(mg_limit_env) > 0 ? atof(mg_limit_env) : 10.0) * 1073741824.0;
  const char* mg_check_env = getenv("MOONGLASS_WAVEFORM_CHECK_CYCLES");
  const long mg_wave_check_cycles = (mg_check_env && atol(mg_check_env) > 0 ? atol(mg_check_env) : 1000000L);
  const char* mg_wave_path = "${baseName}.vcd";` : ''}

  // 初始化信号
  top->${clockName} = 0;
  top->${resetName} = ${resetActiveLow ? '1' : '0'};
${stimulusInitLines ? `\n  // 输入初始化为 0（复位期间不驱动随机激励）\n${stimulusInitLines}\n` : ''}
  // 释放复位
  top->${resetName} = ${resetActiveLow ? '0' : '1'};
  for (int i = 0; i < 5; i++) {
    top->${clockName} = !top->${clockName};
    top->eval();
  }
  top->${resetName} = ${resetActiveLow ? '1' : '0'};

  // [MOONGLASS_AUTO_STIMULUS] 伪随机种子（环境变量可复现）
  const char* mg_seed_env = getenv("MOONGLASS_STIM_SEED");
  uint32_t mg_lfsr = mg_seed_env ? static_cast<uint32_t>(strtoul(mg_seed_env, nullptr, 0)) : 0xACE1u;

  // 主仿真循环
  for (int cycle = 0; cycle < ${numCycles}; cycle++) {
${trace ? `    // [MOONGLASS_WAVEFORM_GUARD] 周期性体积检查：超限只停 dump，仿真继续
    if (tfp && cycle % mg_wave_check_cycles == 0) {
      std::ifstream mg_wave(mg_wave_path, std::ios::binary | std::ios::ate);
      if (mg_wave && static_cast<double>(mg_wave.tellg()) > mg_wave_limit_bytes) {
        tfp->close();
        delete tfp;
        tfp = nullptr;
        printf("MOONGLASS_WAVEFORM_GUARD: dump stopped — 波形已停止记录（超过 %.4f GB），仿真继续\\n", mg_wave_limit_bytes / 1073741824.0);
        fflush(stdout);
      }
    }
` : ''}    // 时钟上升沿
    top->${clockName} = 1;
    top->eval();
${trace ? `    if (tfp) tfp->dump(main_time);\n    main_time++;` : ''}

    // 时钟下降沿
    top->${clockName} = 0;
    top->eval();
${trace ? `    if (tfp) tfp->dump(main_time);\n    main_time++;` : ''}
${stimulusDriveLines ? `
    // [MOONGLASS_AUTO_STIMULUS] 伪随机激励：每周期驱动所有输入（时钟/复位除外），
    // 让 if/case 分支、条件表达式与信号翻转得到基本遍历；写定向测试时替换为具体激励。
${stimulusDriveLines}
    top->eval();
` : ''}
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
        ...(trace ? [`**波形熔断**: 体积超过 MOONGLASS_MAX_WAVEFORM_GB（缺省 10 GB）时只停止波形记录，仿真继续；检查周期 MOONGLASS_WAVEFORM_CHECK_CYCLES（缺省 100 万周期）`] : []),
        ...(stimulusPorts.length > 0
          ? [`**自动激励**: ${stimulusPorts.length} 个输入端口已接入 xorshift32 伪随机激励（MOONGLASS_AUTO_STIMULUS，种子可用 MOONGLASS_STIM_SEED 固定）；写定向测试时请替换为具体激励`]
          : []),
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
    description: '运行 Cocotb Python testbench（推荐，Windows 缺省 Icarus）或兼容旧式 Verilator C++ testbench；统一输出日志、JUnit、result.json 和波形。提供 scenarioIds 时自动把 PASS/FAIL 登记到 scenario_hits.json 并重建验证态势（同时登记用例反向指针：单用例运行写精确 testName，多用例运行整组写 boundTestcases+boundBy=scenarioIds，供态势页绑定列追溯）；scenario_hits.json 由工具自动写入，禁止手工编辑。purpose 声明运行用途：缺省 regression（回归证据）；mutation/probe 为隔离运行——不写 scenario_hits.json、不回写主 result.json 与主目录日志，结果落盘到 verification/results/<topModule>/<purpose>-runs/<用例-时间戳>/，不计入回归判定与场景登记。',
    promptSnippet: 'Run Cocotb or legacy C++ RTL simulation and collect artifacts',
    promptGuidelines: 'Use mode=cocotb with testModule/testDir for MoonGlass verification environments. On Windows prefer simulator=icarus. Use mode=cpp only for an existing C++ testbench. Pass scenarioIds from select_next_verification_batch so scenario hits are auto-registered; never hand-write scenario_hits.json. Mutation/fault-injection or exploratory runs MUST use purpose="mutation" (or "probe") so their expected-FAIL results stay isolated from regression evidence and scenario registration. When authoring tests, bind each test function to its TEST ID in verification/<tb>/test_manifest.json ({"<test函数名>": {"testId": "TEST-..."}}) — or at least put the TEST ID in the first line of the test docstring — so the verification posture panel can map results back to the plan.',
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal('cocotb'), Type.Literal('cpp')], { description: '缺省 cocotb；cpp 仅兼容旧项目' })),
      topModule: Type.String({ description: '顶层模块名（对应 RTL module 名称）' }),
      rtlFiles: Type.Array(Type.String(), { description: 'RTL 文件路径列表' }),
      testModule: Type.Optional(Type.String({ description: 'Cocotb Python 模块名，例如 tests.test_uart（不要带 .py）' })),
      testDir: Type.Optional(Type.String({ description: 'Cocotb 环境根目录，加入 PYTHONPATH' })),
      testcase: Type.Optional(Type.String({ description: '仅运行指定 @cocotb.test 测试，可选' })),
      scenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }), { description: '本用例定向关闭的场景 ID，来自 select_next_verification_batch 返回的批次（仅 purpose=regression 时登记）' })),
      purpose: Type.Optional(Type.Union([Type.Literal('regression'), Type.Literal('mutation'), Type.Literal('probe')], { description: '运行用途，缺省 regression。mutation/probe：变异体故障注入或探查性运行，证据隔离到 verification/results/<topModule>/<purpose>-runs/<用例-时间戳>/，不写 scenario_hits.json、不回写主 result.json 与主目录编译/仿真日志，不计入回归判定与场景登记' })),
      simulator: Type.Optional(Type.Union([Type.Literal('icarus'), Type.Literal('verilator')], { description: 'Cocotb 后端；Windows 缺省 icarus' })),
      tbCpp: Type.Optional(Type.String({ description: 'mode=cpp 时的 C++ 测试台路径' })),
      trace: Type.Optional(Type.Boolean({ description: '是否生成波形，缺省 true' })),
      maxWaveformGB: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: '波形体积熔断阈值（GB），缺省 10，可经环境变量 MOONGLASS_MAX_WAVEFORM_GB 覆盖。cpp 模式（generate_tb 生成的 TB）超限只停 dump、仿真继续；外部自带 TB 只监控并诚实标注；cocotb 模式超限终止仿真并标记 waveformAborted。资源保护，与 timeoutSec 的 wall-clock 语义无关' })),
      rtlCoverage: Type.Optional(Type.Boolean({ description: 'Verilator 后端是否采集 RTL 行、条件/表达式、翻转和 FSM 覆盖率；缺省 true' })),
      functionalCoverageFile: Type.Optional(Type.String({ description: '功能覆盖率 JSON 路径；测试也可读取 MOONGLASS_FUNCTIONAL_COVERAGE_FILE 环境变量写入默认路径' })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, description: '仅在项目有明确依据时设置硬超时；缺省不按 wall-clock 强制终止' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const topModule = params.topModule as string
      const rtlFiles = (params.rtlFiles as string[]).map((file) => resolve(ctx.cwd, file))
      const mode = (params.mode as 'cocotb' | 'cpp' | undefined) ?? 'cocotb'
      // 缺陷 DEFECT-PACK-001#13/#17：显式运行用途。非回归用途（mutation/probe）与回归证据
      // 完全隔离——不写 scenario_hits.json（含 scn_ 自动解析也不登记），结果与编译/仿真日志
      // 落盘到独立目录，不回写主 result.json，避免预期 FAIL 的运行污染黄金证据。
      const purpose = (params.purpose as 'regression' | 'mutation' | 'probe' | undefined) ?? 'regression'
      const tbCpp = params.tbCpp ? resolve(ctx.cwd, params.tbCpp as string) : undefined
      const trace = params.trace as boolean | undefined ?? true
      const maxWaveformGB = resolveMaxWaveformGB(params.maxWaveformGB as number | undefined)
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
        const resultDir = purpose === 'regression'
          ? resolve(ctx.cwd, 'verification', 'results', topModule)
          : resolve(ctx.cwd, 'verification', 'results', topModule, `${purpose}-runs`, `${((params.testcase as string | undefined) ?? 'run').replace(/[^A-Za-z0-9_.-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
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
              maxWaveformGB,
              buildDir: resolve(ctx.cwd, 'verification', `${topModule}_tb`, 'sim', 'sim_build'),
              resultDir
            })
          : await runVerilatorSimulation({
              topModule,
              tbCpp: tbCpp!,
              rtlFiles,
              trace,
              rtlCoverage: params.rtlCoverage as boolean | undefined,
              maxWaveformGB,
              signal,
              buildDir: resolve(ctx.cwd, 'verification', `${topModule}_tb`, 'sim', 'obj_dir'),
              resultDir
            })

        // 回归证据绑定当前 RTL 版本（rtlHash 与 scenario_hits / 阶段门禁同一哈希空间），
        // 供覆盖率门禁做新鲜度过滤——RTL 变更后旧覆盖率数据不再被采信，必须先重采
        if (purpose === 'regression') {
          try {
            const rtlHash = computeRtlHash(resolve(ctx.cwd))
            const data = JSON.parse(readFileSync(result.resultPath, 'utf-8'))
            writeJsonAtomic(result.resultPath, { ...data, rtlHash })
          } catch { /* 哈希计算失败不阻断仿真结果本身 */ }
        }

        const report = [
          `## 仿真结果 — ${topModule}`,
          '',
          `**结果**: ${result.passed ? '✅ 通过' : '❌ 失败'}`,
          `**模式**: ${mode === 'cocotb' ? `Cocotb / ${(params.simulator as string | undefined) ?? 'icarus'}` : 'Verilator C++'}`,
          `**运行用途**: ${purpose}${purpose === 'regression' ? '' : '（证据隔离：不计入回归判定与场景登记）'}`,
          `**VCD 波形**: ${result.vcdPath ? `✅ ${result.vcdPath}` : '❌ 未生成'}`,
          `**编译日志**: ${result.compileLogPath}`,
          `**仿真日志**: ${result.simulationLogPath}`,
          `**结构化结果**: ${result.resultPath}`,
          `**RTL 覆盖率**: ${result.coverage?.lineCoverage === undefined ? '未采集' : `行 ${result.coverage.lineCoverage}% / 条件 ${result.coverage.branchCoverage ?? '暂无'}%`}`,
          `**功能覆盖率**: ${result.coverage?.functionalCoverage === undefined ? '未提供' : `${result.coverage.functionalCoverage}%`}`,
        ]

        // 未覆盖点定位（回归证据）：从 coverage.dat 明细中提取 hits=0 的检测点（含文件/行/列/语义），
        // 让 Agent 直接看到"哪一行哪个分支没被激励到"，作为下一轮定向测试的输入
        if (purpose === 'regression' && result.coverageDataPath) {
          try {
            const detail = parseVerilatorCoverageDetail(result.coverageDataPath)
            if (detail) {
              const uncovered = detail.files.flatMap((f) =>
                f.points.filter((p) => p.hits === 0).map((p) => ({ file: f.file, ...p }))
              )
              const kindLabel: Record<string, string> = { branch: '分支', line: '行', expr: '表达式', toggle: '翻转', fsm_state: 'FSM 状态', fsm_arc: 'FSM 转移' }
              const keyUncovered = uncovered.filter((p) => p.kind === 'branch' || p.kind === 'line')
              if (keyUncovered.length > 0) {
                report.push('', '### 未覆盖点定位（前 20 个行/分支；全量见 coverage-detail.json）', '')
                report.push(...keyUncovered.slice(0, 20).map((p) =>
                  `- ${kindLabel[p.kind] ?? p.kind}: ${p.file}:${p.line}${p.column !== undefined ? `:${p.column}` : ''}${p.origin ? `（${p.origin}）` : ''}`
                ))
              }
              report.push(`未覆盖检测点合计 ${uncovered.length} 个（含表达式/翻转/FSM 全类型，文件/行/列/层级见 coverage-detail.json）`)
            }
          } catch { /* 明细解析失败不影响仿真结果本身 */ }
        }

        // 波形体积熔断留痕（C6 工具/插桩类）：诚实区分三种行为，不假装外部 TB 也能熔断
        let waveformGuard: WaveformGuardRecord | undefined
        if (result.waveformAborted) {
          waveformGuard = {
            classification: 'C6_TOOL_INSTRUMENTATION',
            behavior: mode === 'cpp' ? 'dump-stopped' : 'simulation-aborted',
            detail: mode === 'cpp'
              ? `波形超过阈值 ${maxWaveformGB} GB，TB 内已停止 dump，仿真与覆盖率结果完整`
              : `波形超过阈值 ${maxWaveformGB} GB；cocotb 后端外部无法只停 dump，已终止仿真（PASS/FAIL 随之反映终止）`
          }
          report.push('', `**波形熔断**: ⚠️ ${waveformGuard.detail}`)
        } else if (result.waveformOverLimitUncontrolled) {
          waveformGuard = {
            classification: 'C6_TOOL_INSTRUMENTATION',
            behavior: 'uncontrolled-over-limit',
            detail: mode === 'cpp'
              ? `外部自带 C++ TB 不含熔断标记，波形已超过阈值 ${maxWaveformGB} GB 但未受控停止；如需受控熔断请用 generate_tb 重新生成 TB`
              : `波形超过阈值 ${maxWaveformGB} GB，但触发时仿真已自然结束，未能实际终止 dump（FST 缓冲可能只在收尾落盘）`
          }
          report.push('', `**波形超限未受控**: ⚠️ ${waveformGuard.detail}`)
        }

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
          evidence: [result.compileLogPath, result.simulationLogPath, result.resultPath, result.vcdPath ?? '', result.coverageReportPath ?? ''],
          waveformGuard
        })
        report.push('', '### 渐进式诊断控制', '', `**诊断等级**: ${diagnostic.attempts.at(-1)?.diagnosticLevel ?? 'L0'}`, `**本次耗时**: ${Math.round((diagnostic.attempts.at(-1)?.durationMs ?? 0) / 1000)} 秒（仅记录，不据此强制终止）`, `**当前模式**: ${diagnostic.mode}`, `**建议**: ${diagnostic.recommendation}`, '', '诊断账本：verification/results/diagnostic-control.json')

        // 缺陷 DEFECT-PACK-001#17 防线兜底：回归用途的失败运行若覆盖了既有成功
        // result.json，eda-bridge 已把旧文件旁路归档，此处显式告知 Agent 证据可追溯。
        if (result.archivedResultPath) {
          report.push('', `**成功证据保护**: ⚠️ 本次失败结果未直接覆盖既有成功证据，旧 result.json 已旁路归档为 ${result.archivedResultPath}`)
        }

        // 证据管线：PASS/FAIL 都自动登记 scenario_hits（失败同样是证据），并重建验证态势
        // 从本次 JUnit XML 的 testcase name 解析 scn_<8hex> 标记 → 测试函数名，
        // 随条目写入 testName，供验证态势面板把场景映射回 TEST ID（拿不到就不写）
        // 缺陷 DEFECT-PACK-001#13：仅 purpose=regression 登记；mutation/probe 运行
        // （预期 FAIL 的故障注入、探查）不得触碰 scenario_hits.json 与验证态势
        let scenarioHitsRegistered: string[] = []
        if (purpose === 'regression') {
          const testNames: Record<string, string> = {}
          // BUG-VERIF-BIND-001：收集本次运行实际执行的全部测试函数（非 skipped），
          // 作为 scenarioIds 绑定路径的用例反向指针（单用例→精确 testName；多用例→boundTestcases）
          const runTestcases: string[] = []
          if (result.resultsXmlPath && existsSync(result.resultsXmlPath)) {
            const xml = readFileSync(result.resultsXmlPath, 'utf-8')
            for (const el of xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)) {
              const rawName = /name="([^"]+)"/.exec(el[0])?.[1]
              if (!rawName) continue
              if (/<skipped\b/.test(el[0])) continue
              const funcName = /\b(test_\w+)/.exec(rawName)?.[1]
              if (funcName) runTestcases.push(funcName)
              if (!/scn_[0-9a-fA-F]{8}/.test(rawName)) continue
              for (const scn of rawName.matchAll(/scn_([0-9a-fA-F]{8})/g)) testNames[`SCN-${scn[1].toUpperCase()}`] = funcName ?? rawName
            }
          }
          const hits = writeScenarioHits(resolve(ctx.cwd), topModule, {
            scenarioIds: params.scenarioIds as string[] | undefined,
            testcase: params.testcase as string | undefined,
            testNames,
            runTestcases,
            passed: result.passed,
            channel: 'simulation',
            tool: 'run_simulation',
            // 方案 C 批 1（§3.3）：FAIL 时失败摘要/指纹随登记落盘（与 diagnostic-control 同一次归一化产出）
            ...(result.passed ? {} : { failureSummary: failureSummary(result.log), failureSignature: failureSignature(result.log) }),
            rtlFiles,
            evidence: [result.resultPath, result.simulationLogPath, result.vcdPath ?? '']
          })
          scenarioHitsRegistered = hits.registered
          report.push('', '### Scenario 证据登记', '')
          if (hits.registered.length) report.push(`已自动登记 ${hits.registered.length} 个场景到 scenario_hits.json：${hits.registered.join('、')}`)
          for (const warning of hits.warnings) report.push(`⚠️ ${warning}`)
          const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
          report.push(rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次仿真结果）：${rebuildError}` : '态势快照已自动重建，验证态势页刷新即可见')
        } else {
          report.push('', '### 运行用途隔离', '', `本次为 ${purpose} 用途运行，证据已隔离到 ${resultDir}，未计入回归判定与场景登记（scenario_hits.json 与主 result.json 均未改动）。`)
        }

        return {
          content: [{ type: 'text', text: report.join('\n') }],
          details: {
            passed: result.passed,
            purpose,
            logPreview: result.log.slice(0, 1000),
            vcdPath: result.vcdPath,
            compileLogPath: result.compileLogPath,
            simulationLogPath: result.simulationLogPath,
            resultPath: result.resultPath,
            archivedResultPath: result.archivedResultPath,
            coverage: result.coverage,
            coverageReportPath: result.coverageReportPath,
            diagnostic,
            scenarioHits: scenarioHitsRegistered
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
    description: '调用 Yosys 完成逻辑综合，输出门级 Verilog 网表、JSON 网表、日志和 Markdown 报告。无 Liberty 时报告通用单元数；提供 Liberty 时执行工艺映射并尝试解析面积和 ABC 延迟。提供 scenarioIds 时综合成功即自动把 PASS 登记到 scenario_hits.json（channel=synthesis，PPA 条款的 SYNTH 阶段验收证据）并重建验证态势；scenario_hits.json 由工具自动写入，禁止手工编辑。',
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
          channel: 'synthesis',
          tool: 'run_logic_synthesis',
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
    description: '对工作区 RTL 代码进行时钟域交叉（Clock Domain Crossing）静态分析。检测多时钟域设计、跨域信号路径，并检查是否存在标准同步器（2-flop / async FIFO）。输出 CDC 报告与修复建议。提供 scenarioIds 时，把本次检查结果作为这些静态通道场景的执行证据登记到 scenario_hits.json（channel=static，PASS/FAIL 都登记，passed=无 error 级发现）并重建验证态势。',
    promptSnippet: 'Run clock domain crossing analysis on the RTL design',
    promptGuidelines: 'Use run_cdc_check in multi-clock designs to find CDC issues. Always use 2-flop synchronizers for single-bit CDC and async FIFOs for multi-bit CDC. For batches from select_next_verification_batch whose scenarios are static-channel (method=static), pass their scenarioIds so the check result is registered as scenario execution evidence.',
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: '扫描目录（缺省为工作区 rtl/）' })),
      scenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }), { description: '本次检查定向闭环的静态通道场景 ID；提供时把本次检查结果作为这些场景的执行证据登记到 scenario_hits.json（channel=static）' }))
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

      // error 级发现集合：当前分析器仅收集 potentialViolations（尚无填充逻辑），
      // 统一从该集合判定 passed，后续分析器升级 error 发现时登记口径不变
      const errorFindings = potentialViolations

      // BUG-VERIF-BATCH-001：静态通道场景证据登记——passed = 无 error 级发现，
      // channel=static，证据=rtlqa/cdc/cdc_report.md，rtlHash 由 writeScenarioHits 自算，
      // 登记后重建验证态势；仅在提供 scenarioIds 时登记，未提供时行为与现状完全一致
      let scenarioHitsRegistered: string[] = []
      if (params.scenarioIds) {
        const cdcTopModule = readRtlInputs(ctx.cwd).topModule
        if (cdcTopModule) {
          const cdcReportDir = join(resolve(ctx.cwd), 'rtlqa', 'cdc')
          mkdirSync(cdcReportDir, { recursive: true })
          const cdcReportMd = join(cdcReportDir, 'cdc_report.md')
          writeFileSync(cdcReportMd, report.join('\n'), 'utf-8')
          const hits = writeScenarioHits(resolve(ctx.cwd), cdcTopModule, {
            scenarioIds: params.scenarioIds as string[] | undefined,
            passed: errorFindings.length === 0,
            channel: 'static',
            tool: 'run_cdc_check',
            rtlFiles: files,
            evidence: [cdcReportMd]
          })
          scenarioHitsRegistered = hits.registered
          report.push('', '### Scenario 证据登记', '')
          if (hits.registered.length) report.push(`已自动登记 ${hits.registered.length} 个场景到 scenario_hits.json：${hits.registered.join('、')}`)
          for (const warning of hits.warnings) report.push(`⚠️ ${warning}`)
          const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
          report.push(rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次检查结果）：${rebuildError}` : '态势快照已自动重建，验证态势页刷新即可见')
        } else {
          report.push('', '### Scenario 证据登记', '', '⚠️ rtl/design.json 未声明顶层模块，无法定位 scenario_hits.json，跳过静态证据登记（请在 design.json 补 topModule 后重试）')
        }
      }

      return {
        content: [{ type: 'text', text: report.join('\n') }],
        details: {
          files: files.length,
          clockDomains: [...clockDomains.keys()],
          clockCount: clockDomains.size,
          synchronizersFound: synchronizers.length,
          isMultiClock,
          resets: [...resetSignals],
          scenarioHits: scenarioHitsRegistered
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
    name: 'record_experience_note',
    label: 'Record Experience Note',
    description: '把可复用验证经验落盘到 verification/results/experience-notes.json（验证长程循环"战略层"经验账本，批次/修复会话间传递，消灭每批重复探索）。调用时机：掌握环境用法（编译命令/cocotb make 参数/工具链版本/目录约定）、testbench 陷阱（scoreboard 比较口径/时钟相位/复位释放条件）、已验证构建参数、典型失败模式（某类竞态/溢出的表象与定位路径）时，在批次、修复、诊断会话收尾顺手登记。常规问答禁止调用本工具。text ≤200 字、tags ≤5 个（每个 ≤24 字）；同 text+tags 重复登记幂等复用 id 并刷新时间戳。禁止手写 experience-notes.json。',
    promptSnippet: 'Record a reusable verification experience for future batch or fix sessions',
    promptGuidelines: 'Call only when a batch/fix/diagnostic session produced something reusable: environment usage, testbench pitfalls, verified build parameters, or typical failure patterns. Never call for routine Q&A. Keep text ≤200 chars, tags ≤5 (each ≤24 chars). Identical text+tags reuses the same id, so do not re-register what is already logged.',
    parameters: Type.Object({
      text: Type.String({ maxLength: 200, description: '经验正文，≤200 字：一句话说清做法/陷阱/参数与适用场景' }),
      tags: Type.Optional(Type.Array(Type.String({ maxLength: 24 }), { maxItems: 5, description: '经验标签（≤5 个，每个 ≤24 字），如 env-usage / tb-pitfall / build-param / failure-pattern / 模块名 / 场景 id' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const record = appendExperienceNoteLedger(resolve(ctx.cwd), { text: params.text, tags: params.tags ?? [], source: 'pi-agent' })
        return {
          content: [{ type: 'text', text: `## 经验登记\n\n- 经验 ID：${record.id}\n- 标签：${record.tags.length ? record.tags.join('、') : '无'}\n- 落盘：verification/results/experience-notes.json（新前 ≤50 条，批次 prompt 自动注入经验摘要）` }],
          details: { record },
          isError: false
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `经验登记被拒绝：${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true }
      }
    }
  })

  pi.registerTool({
    name: 'propose_run_decision',
    label: 'Propose Run Loop Decision',
    description: '向 MoonGlass 验证运行循环的决策账本登记一条下一步行动提案（verification/results/decision-ledger.json，追加式）。仅当处于循环决策升级会话（规则空转/熔断恢复，由主进程派发）或用户在会话中明确指示改变循环方向时才允许调用；常规验证工作禁止调用本工具。trigger=user-instruction（工程师明确指示）时登记为 source=human 并直接批准，循环自动执行；其余登记为 source=llm、status=proposed，经决策卡片由工程师批准后才执行（顾问模式默认，委托模式未开启）。action.expectedOutput 与 action.stopCriteria 必填且必须非空；derived 类 actionId 必须是推导内核已知动作 id（规则层白名单校验，幻觉动作会在批准时被拒）。',
    promptSnippet: 'Propose the next run-loop action as a ledger decision during an escalation session or on explicit user instruction',
    promptGuidelines: 'Call only in a run-loop decision escalation session (dispatched by MoonGlass on rule-stall or breaker-recovery) or when the user explicitly instructs a direction change in this conversation. Keep rationale ≤200 chars. expectedOutput and stopCriteria are required and must be non-empty. For derived actions use a real derived action id from the verification guidance kernel; for custom instructions pass actionId=null. After registering, the proposal goes to the engineer via a decision card; do not re-submit duplicates.',
    parameters: Type.Object({
      trigger: Type.Union([
        Type.Literal('rule-stall', { description: '规则空转升级会话（主进程派发）' }),
        Type.Literal('breaker-recovery', { description: '熔断恢复升级会话（主进程派发）' }),
        Type.Literal('user-instruction', { description: '用户在会话中明确指示改方向（登记为工程师决策，直接批准）' })
      ], { description: '登记触发' }),
      action: Type.Object({
        kind: Type.Union([Type.Literal('derived'), Type.Literal('custom')], { description: 'derived=引用推导内核已知动作 id；custom=自由指令（actionId 必须传 null）' }),
        actionId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'derived 类必填：推导内核已知动作 id；custom 类必须为 null 或省略' })),
        prompt: Type.String({ minLength: 1, description: '具体可执行的动作指令（≤4000 字；经决策卡片批准后以任务会话派发执行）' }),
        expectedOutput: Type.String({ minLength: 1, description: '期望产出，必填非空' }),
        stopCriteria: Type.String({ minLength: 1, description: '停止条件，必填非空' })
      }),
      rationale: Type.String({ minLength: 1, maxLength: 200, description: '决策理由，≤200 字' }),
      evidenceRefs: Type.Array(Type.String(), { description: '证据锚点（相对工作区的账本/证据文件路径，须真实读取过）' })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        if (params.action.prompt.length > 4000) throw new Error(`prompt 超过 4000 字上限（当前 ${params.action.prompt.length} 字）`)
        if (params.action.kind === 'derived' && !params.action.actionId?.trim()) {
          throw new Error("kind='derived' 时必须提供非空 actionId（推导内核已知动作 id）")
        }
        if (params.action.kind === 'custom' && params.action.actionId != null) {
          throw new Error("kind='custom' 时 actionId 必须为 null（自由指令不挂推导动作 id）")
        }
        const source = params.trigger === 'user-instruction' ? 'human' : 'llm'
        const record = appendRunLoopDecisionLedger(resolve(ctx.cwd), {
          source,
          trigger: params.trigger,
          action: {
            kind: params.action.kind,
            actionId: params.action.kind === 'derived' ? params.action.actionId!.trim() : null,
            prompt: params.action.prompt,
            expectedOutput: params.action.expectedOutput,
            stopCriteria: params.action.stopCriteria
          },
          rationale: params.rationale,
          evidenceRefs: params.evidenceRefs
        })
        const statusText = record.status === 'approved'
          ? '已批准（工程师指令不审批，循环将自动拾取执行）'
          : '已登记为待审批提案（顾问模式：经决策卡片由工程师批准后才执行）'
        return {
          content: [{ type: 'text', text: `## 循环决策登记\n\n- 决策 ID：${record.id}\n- 来源/触发：${record.source} / ${record.trigger}\n- 状态：${statusText}\n- 落盘：verification/results/decision-ledger.json` }],
          details: { record },
          isError: false
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `循环决策登记被拒绝：${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true }
      }
    }
  })

  pi.registerTool({
    name: 'register_ut_escalation',
    label: 'Register UT Escalation',
    description: '登记/退役 UT 例外（TOP 优先，UT 例外策略）：诊断账本升级到 L3/L4、probe 子模块信号仍无法定位后，经本工具登记为例外模块并单独建 TB；例外 PASS 不替代 TOP 回归证据。预防性 UT 允许登记（failureSignature 传空，reason 必须写明预防性理由）。登记落 verification/results/ut-escalations.json（证据区审计线索），成功后自动重建验证态势（策略表该模块显示 UT_EXCEPTION、场景锚点放开、执行计划纳入排队）；退役保留历史。未经登记禁止直接搭模块 Testbench。',
    promptSnippet: 'Register a diagnosis-driven UT exception after TOP-level probes fail to localize',
    promptGuidelines: 'Call only after the diagnostic ledger reaches L3/L4 and probing submodule signals still cannot localize the failure (or explicitly as a preventive UT with the rationale in reason). Anchors are validated: module must exist in the structural model, topScenarioIds must exist in scenario-registry, rootCauseId must exist in root-causes.json. Fix rejected anchors and re-register; never bypass by editing ut-escalations.json.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('register'), Type.Literal('retire')], { description: 'register=登记例外；retire=退役该模块的 active 例外（需 retiredReason）' }),
      module: Type.String({ minLength: 1, description: 'RTL 模块名（结构模型中必须存在）' }),
      reason: Type.String({ minLength: 1, maxLength: 200, description: '≤200 字：为什么 TOP 激励/观测不足以定位；预防性 UT 时写明预防性理由' }),
      failureSignature: Type.Optional(Type.String({ description: '关联 diagnostic-control 失败指纹；预防性 UT 可省略或传空' })),
      rootCauseId: Type.Optional(Type.String({ description: '关联 root-causes.json 记录（RC-*），引擎校验存在性；可省略' })),
      topScenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^SCN-[A-F0-9]{8}$' }), { description: '触发升级的 TOP 场景（必须在 scenario-registry 中存在）；预防性 UT 可省略或传空数组' })),
      retiredReason: Type.Optional(Type.String({ minLength: 1, description: 'action=retire 必填：退役依据（如根因修复且 TOP 回归已覆盖）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: 'text', text: params.action === 'register' ? '正在校验锚点并登记 UT 例外…' : '正在退役 UT 例外…' }] })
      try {
        if (params.action === 'retire') {
          if (!params.retiredReason?.trim()) throw new Error('action=retire 必须提供 retiredReason（退役依据）')
          // 工具层按模块解析 active 例外 id（引擎退役接口以 id 为锚）
          const escalationsPath = join(ctx.cwd, 'verification', 'results', 'ut-escalations.json')
          const activeForModule: Array<{ id: string; reason: string }> = []
          if (existsSync(escalationsPath)) {
            try {
              const parsed = JSON.parse(readFileSync(escalationsPath, 'utf-8')) as { escalations?: Array<{ id: string; module: string; status: string; reason: string }> }
              for (const item of parsed.escalations ?? []) {
                if (item.module === params.module && item.status === 'active') activeForModule.push({ id: item.id, reason: item.reason })
              }
            } catch { /* 文件损坏按无登记处理，由引擎接口报错 */ }
          }
          if (!activeForModule.length) throw new Error(`模块 ${params.module} 没有 active 的 UT 例外可退役`)
          const retired = activeForModule.map((item) => retireUtEscalation(ctx.cwd, item.id, params.retiredReason))
          const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
          return {
            content: [{ type: 'text', text: `## UT 例外退役\n\n- 模块：${params.module}\n- 退役：${retired.map((item) => `${item.id}（${item.reason.slice(0, 40)}）`).join('、')}\n- 依据：${params.retiredReason}\n- ${rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次退役）：${rebuildError}` : '态势快照已自动重建（策略表恢复 COVERED_BY_TOP），退役记录保留供签核审计'}` }],
            details: { retired },
            isError: false
          }
        }
        const result = registerUtEscalation(ctx.cwd, {
          module: params.module,
          reason: params.reason,
          failureSignature: params.failureSignature ?? null,
          rootCauseId: params.rootCauseId ?? null,
          topScenarioIds: params.topScenarioIds ?? []
        })
        const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
        return {
          content: [{ type: 'text', text: `## UT 例外登记\n\n- 记录 ID：${result.record.id}${result.reused ? '（同模块同 reason 已存在，幂等复用）' : ''}\n- 模块：${result.record.module}\n- 理由：${result.record.reason}\n- 失败指纹：${result.record.failureSignature ?? '（预防性 UT，无指纹）'}\n- 关联 TOP 场景：${result.record.topScenarioIds.join('、') || '无'}\n- 落盘：verification/results/ut-escalations.json\n- ${rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次登记）：${rebuildError}` : '态势快照已自动重建：策略表该模块显示 UT_EXCEPTION，模块场景锚点放开并纳入执行计划；修复后须回 TOP 回归确认，例外 PASS 不替代 TOP 证据'}` }],
          details: { record: result.record, reused: result.reused },
          isError: false
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `UT 例外登记/退役被拒绝：${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true }
      }
    }
  })

  pi.registerTool({
    name: 'register_config_space',
    label: 'Register Config Space',
    description: '登记配置空间账本（config-space.json，引擎产物区 Agent 禁手改）：从规格书寄存器/配置章节抽取寄存器、字段、取值域（enum/range/flag）与约束（mutex/requires/illegal），引擎做锚点校验（rtlModule 存在、字段名在该模块 RTL 源码可检索、clauseId 在 requirement-model 存在、非法 domain 与悬空 constraint 引用拒绝）后落盘并自动重建验证态势。rebuild 时引擎按四类配置点（业务/边界/非法/动态）生成 CONFIG_DERIVED 场景候选。规格书缺寄存器章节时不得编造——先转 Spec Gap 阻断。',
    promptSnippet: 'Register the machine-readable config register space after reading the spec register chapter',
    promptGuidelines: 'Read the specification register/config chapter first (register names, offsets, field bit ranges, reset values, value encodings, legal/illegal combinations). If the spec has no register chapter, register a Spec Gap instead of inventing registers. Field names must be real RTL identifiers in the anchored module. Constraints must state the expected DUT behavior (error/ignore/truncate). Never edit config-space.json by hand.',
    parameters: Type.Object({
      registers: Type.Array(Type.Object({
        name: Type.String({ minLength: 1, description: '寄存器名（规格书口径）' }),
        address: Type.Optional(Type.Union([Type.String(), Type.Null()]), { description: '偏移地址，规格未写可省略或传 null' }),
        rtlModule: Type.String({ minLength: 1, description: '锚定的寄存器模块（如 apb_regs），必须在结构模型中存在' }),
        fields: Type.Array(Type.Object({
          name: Type.String({ minLength: 1 }),
          msb: Type.Integer({ minimum: 0 }),
          lsb: Type.Integer({ minimum: 0 }),
          resetValue: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          domain: Type.Union([
            Type.Object({ kind: Type.Literal('enum'), values: Type.Array(Type.Object({ value: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) }), { minItems: 1 }) }),
            Type.Object({ kind: Type.Literal('range'), min: Type.Number(), max: Type.Number() }),
            Type.Object({ kind: Type.Literal('flag') })
          ]),
          clauseId: Type.Optional(Type.Union([Type.String(), Type.Null()]), { description: '规格条款锚点（SPEC-xxx#a），引擎校验存在性' }),
          description: Type.String({ minLength: 1, maxLength: 120, description: '≤120 字字段语义' })
        }), { minItems: 1 })
      }), { minItems: 1 }),
      constraints: Type.Array(Type.Object({
        type: Type.Union([Type.Literal('mutex'), Type.Literal('requires'), Type.Literal('illegal')]),
        fields: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: '<register>.<field> 引用，必须已在 registers 声明' }),
        description: Type.String({ minLength: 1, description: '约束语义与期望行为（报错/忽略/截断）' }),
        clauseId: Type.Optional(Type.Union([Type.String(), Type.Null()]))
      }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: 'text', text: '正在校验配置空间锚点并落盘…' }] })
      try {
        const configSpace = registerConfigSpace(ctx.cwd, {
          registers: params.registers.map((register) => ({ ...register, address: register.address ?? null, fields: register.fields.map((field) => ({ ...field, resetValue: field.resetValue ?? null, clauseId: field.clauseId ?? null })) })),
          constraints: params.constraints.map((constraint) => ({ ...constraint, clauseId: constraint.clauseId ?? null }))
        })
        const rebuildError = rebuildVerificationPosture(resolve(ctx.cwd))
        return {
          content: [{ type: 'text', text: `## 配置空间登记\n\n- 寄存器：${configSpace.registers.length}（${configSpace.registers.map((item) => item.name).join('、')}）\n- 字段：${configSpace.registers.reduce((sum, item) => sum + item.fields.length, 0)}\n- 约束：${configSpace.constraints.length}\n- 落盘：verification/intelligence/config-space.json\n- ${rebuildError ? `⚠️ 态势快照自动重建失败（不影响本次登记）：${rebuildError}` : '态势快照已自动重建：四类配置点（业务/边界/非法/动态）已生成 CONFIG_DERIVED 场景候选进入候选池（与普通场景共用执行计划 cap，按需提升）'}` }],
          details: { registers: configSpace.registers.length, constraints: configSpace.constraints.length },
          isError: false
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `配置空间登记被拒绝：${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true }
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
      // #8：Formal 证据进入工作区统一哈希空间（computeRtlHash，与新鲜度判定同一口径）；
      // 分层约束：eda-bridge 不得 import verification-intelligence-engine，由桥接层穿线；
      // 引擎口径失败时不传 workspaceRtlHash，eda-bridge 回退旧行为（清单哈希记入 scopeHash）
      let workspaceRtlHash: string | undefined
      try { workspaceRtlHash = computeRtlHash(ctx.cwd) } catch { workspaceRtlHash = undefined }
      const result = await runFormalVerification({ workspaceDir: ctx.cwd, ...params, workspaceRtlHash, signal })
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
      // 缺陷 DEFECT-PACK-001#14：签核证据审查与引擎同一口径——只认顶层模块目录直下的
      // result.json；mutation/probe 隔离运行（*-runs/）与其他深层 result.json 不计入
      const resultFiles = collectEvidenceFiles(resultsDir, (name) => name === 'result.json')
        .filter((file) => relative(resultsDir, file).split(/[\\/]/).length === 2)
      const testFiles = collectEvidenceFiles(resolve(ctx.cwd, 'verification'), (name) => /^(?:test_.+|.+_test)\.py$/i.test(name))
      const blockers: string[] = []
      const warnings: string[] = []
      // 缺陷 DEFECT-PACK-001#10：逐份 result.json 记录必需证据集合的判定依据，审查报告中回显
      const evidenceBasis: string[] = []
      let minimumLine: number | undefined
      let minimumBranch: number | undefined
      let minimumFunctional: number | undefined
      let totalTests = 0
      let passedTests = 0
      let skippedTests = 0
      // 陈旧证据防线：rtlHash 与当前 RTL 不一致（或缺失）的 result.json 不参与
      // 覆盖率阈值与必需证据判定，避免旧 RTL 的 PASS 污染签核审查
      let currentRtlHash: string | null = null
      try { currentRtlHash = computeRtlHash(resolve(ctx.cwd)) } catch { currentRtlHash = null }
      let staleResultCount = 0
      for (const file of resultFiles) {
        try {
          const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
          if (currentRtlHash && data.rtlHash !== currentRtlHash) { staleResultCount += 1; continue }
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
          // 缺陷 DEFECT-PACK-001#10：必需证据集合按 framework/simulator 推导——cocotb 路径
          // 以 resultsXml+simulationLogPath+compileLogPath 为准，判定依据写入审查报告回显
          const isDualChannel = data.functionalPassed !== undefined && data.rtlCoveragePassed !== undefined
          const isCocotb = data.framework === 'cocotb'
          const requiredEvidence = isDualChannel
            ? ['functionalCompileLogPath', 'functionalSimulationLogPath', 'rtlCompileLogPath', 'rtlSimulationLogPath', 'resultsXml', 'coverageDataPath', 'coverageReportPath']
            : isCocotb
              ? ['resultsXml', 'simulationLogPath', 'compileLogPath']
              : ['compileLogPath', 'simulationLogPath']
          evidenceBasis.push(`${relative(ctx.cwd, file)}：${isDualChannel
            ? '双通道结果（functionalPassed+rtlCoveragePassed 齐备），必需集合=functional/rtl 编译与仿真日志+resultsXml+coverageDataPath+coverageReportPath'
            : isCocotb
              ? `framework=cocotb${typeof data.simulator === 'string' ? `/simulator=${data.simulator}` : ''}，必需集合=resultsXml+simulationLogPath+compileLogPath`
              : '单通道结果（无 framework 标记），必需集合=compileLogPath+simulationLogPath'}`)
          const isEvidenceValid = (name: string): boolean => {
            const p = typeof data[name] === 'string' ? data[name] as string : ''
            return Boolean(p) && existsSync(p) && statSync(p).size > 0
          }
          for (const evidence of requiredEvidence) {
            if (isEvidenceValid(evidence)) continue
            const path = typeof data[evidence] === 'string' ? data[evidence] as string : ''
            // 缺陷 DEFECT-PACK-001#10：存量 0 字节编译日志为旧版 cocotb 工具产物（编译实际由
            // cocotb make 统一执行、旧版未写编译段）；resultsXml 与 simulationLog 有效且回归
            // passed 时降级为 warning 而非 blocker，重新运行 run_simulation 可生成真实编译日志
            const legacyEmptyCompileLog = isCocotb && evidence === 'compileLogPath'
              && Boolean(path) && existsSync(path) && statSync(path).size === 0
              && data.passed === true
              && isEvidenceValid('resultsXml') && isEvidenceValid('simulationLogPath')
            if (legacyEmptyCompileLog) {
              warnings.push(`${relative(ctx.cwd, file)} 的 compileLogPath 为旧版工具产生的空编译日志（已降级警告；重新运行 run_simulation 可生成真实编译日志）`)
            } else {
              blockers.push(`${relative(ctx.cwd, file)} 缺少有效 ${evidence}`)
            }
          }
        } catch { blockers.push(`结果文件无法解析：${relative(ctx.cwd, file)}`) }
      }
      if (resultFiles.length === 0) blockers.push('未找到 verification/results/<module>/result.json（隔离运行目录不计入）')
      if (staleResultCount > 0) warnings.push(`${staleResultCount} 份回归结果属于旧 RTL 版本（rtlHash 与当前不一致或缺失），已从审查剔除——如需采信请重新回归`)
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
      // 软强制（战略层经验账本，与"无根因记录"同风格、不阻断）：FAIL→PASS 场景若
      // experience-notes.json 无该场景标签（场景 id 作 tag 关联）的关联经验 → 提醒顺手登记
      const experienceTags = new Set<string>()
      try {
        const experienceNotes = JSON.parse(readFileSync(join(resultsDir, 'experience-notes.json'), 'utf-8')) as { notes?: Array<{ tags?: unknown }> }
        for (const note of experienceNotes.notes ?? []) {
          if (Array.isArray(note.tags)) for (const tag of note.tags) experienceTags.add(String(tag))
        }
      } catch { /* 无经验账本时按空集合处理 */ }
      if (failedModules.size) {
        for (const file of collectEvidenceFiles(resultsDir, (name) => name === 'scenario_hits.json')) {
          if (!failedModules.has(basename(dirname(file)))) continue
          try {
            const hits = JSON.parse(readFileSync(file, 'utf-8')) as { scenarios?: Array<{ id?: string; passed?: boolean }> }
            for (const scenario of hits.scenarios ?? []) {
              if (scenario.passed === true && scenario.id && !confirmedRootCauses.has(scenario.id)) {
                warnings.push(`场景 ${scenario.id} 曾 FAIL 后转 PASS，但 root-causes.json 无 confirmed 根因记录；请用 record_root_cause 补登记（含已证伪假设链）`)
              }
              if (scenario.passed === true && scenario.id && !experienceTags.has(scenario.id)) {
                warnings.push(`场景 ${scenario.id} 曾 FAIL 后转 PASS，但 experience-notes.json 无该场景标签的关联经验；请用 record_experience_note 顺手登记可复用经验（环境用法/testbench 陷阱/已验证构建参数/典型失败模式）`)
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
      const review = { verdict, reviewedAt: new Date().toISOString(), evidence: { resultFiles: resultFiles.map((file) => relative(ctx.cwd, file)), testFiles: testFiles.map((file) => relative(ctx.cwd, file)), totalTests, passedTests, skippedTests }, evidenceBasis, coverage: { lineCoverage: minimumLine ?? null, branchCoverage: minimumBranch ?? null, functionalCoverage: minimumFunctional ?? null }, thresholds: { line: lineThreshold, branch: branchThreshold, functional: functionalThreshold }, blockers, warnings }
      mkdirSync(resultsDir, { recursive: true })
      const jsonPath = join(resultsDir, 'verification_signoff_review.json')
      const reportPath = join(resultsDir, 'verification_signoff_review.md')
      writeFileSync(jsonPath, JSON.stringify(review, null, 2), 'utf-8')
      writeFileSync(reportPath, `# 验证证据独立审查\n\n- 结论：${verdict === 'passed' ? '通过' : verdict === 'conditional' ? '有限通过' : '拒绝签核'}\n- 回归：${passedTests}/${totalTests}\n- 行覆盖率：${minimumLine ?? '暂无'}%\n- 条件/分支覆盖率：${minimumBranch ?? '暂无'}%\n- 功能覆盖率：${minimumFunctional ?? '暂无'}%\n\n## 必需证据判定依据\n${evidenceBasis.length ? evidenceBasis.map((item) => `- ${item}`).join('\n') : '- 无 result.json 可判定'}\n\n## 阻断项\n${blockers.length ? blockers.map((item) => `- ${item}`).join('\n') : '- 无'}\n\n## 警告\n${warnings.length ? warnings.map((item) => `- ${item}`).join('\n') : '- 无'}\n`, 'utf-8')
      return { content: [{ type: 'text', text: `## 验证证据审查\n\n**结论**：${verdict === 'passed' ? '通过' : verdict === 'conditional' ? '有限通过' : '拒绝签核'}\n\n${blockers.length ? `### 阻断项\n${blockers.map((item) => `- ${item}`).join('\n')}` : '无阻断项。'}\n\n报告：${reportPath}` }], details: { ...review, jsonPath, reportPath }, isError: verdict === 'rejected' }
    }
  })
}
