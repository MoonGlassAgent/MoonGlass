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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
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
import { collectRtlFiles, readRtlInputs } from './eda-bridge/rtl-files'
import { buildVerificationIntelligence, registerVerificationHypotheses, reviewScenarioClosure } from './verification-intelligence/engine.ts'

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
    description: '调用 Verible（或回退 Verilator）对 Verilog/SystemVerilog 文件进行代码风格检查。返回通过的 Lint 分区（Error/Warning）及详情。支持自动修复（autofix）。',
    promptSnippet: 'Run lint on a Verilog/SystemVerilog file to check for code issues',
    promptGuidelines: 'Use run_verible_lint after writing or editing RTL code to check for coding issues. Fix all errors before proceeding to synthesizability check.',
    parameters: Type.Object({
      filePath: Type.String({ description: '目标文件路径（绝对路径，或相对 cwd 的路径）' }),
      rulesFile: Type.Optional(Type.String({ description: 'Verible 规则配置文件路径（可选，仅 verible 引擎生效）' })),
      autofix: Type.Optional(Type.Boolean({ description: '是否启用 autofix（仅 verible 支持，会就地修改文件）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const filePath = params.filePath as string
      const rulesFile = params.rulesFile as string | undefined
      const autofix = params.autofix as boolean | undefined

      if (!existsSync(filePath)) {
        return {
          content: [{ type: 'text', text: `错误：文件不存在 — ${filePath}` }],
          isError: true,
          details: {}
        }
      }

      // 优先使用 verible，没有则回退 verilator
      const veribleResult = await tryVerible(filePath, signal, rulesFile, autofix)
      let result: { engine: string; errors: LintIssue[]; warnings: LintIssue[]; fixedCode: string | null }

      if (veribleResult) {
        result = veribleResult
      } else {
        result = await tryVerilatorLint(filePath, signal)
      }

      const errorCount = result.errors.length
      const warningCount = result.warnings.length
      const passed = errorCount === 0

      const report = [
        `## Lint Result — ${filePath}`,
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
    description: '运行 Cocotb Python testbench（推荐，Windows 缺省 Icarus）或兼容旧式 Verilator C++ testbench；统一输出日志、JUnit、result.json 和波形。',
    promptSnippet: 'Run Cocotb or legacy C++ RTL simulation and collect artifacts',
    promptGuidelines: 'Use mode=cocotb with testModule/testDir for MoonGlass verification environments. On Windows prefer simulator=icarus. Use mode=cpp only for an existing C++ testbench.',
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal('cocotb'), Type.Literal('cpp')], { description: '缺省 cocotb；cpp 仅兼容旧项目' })),
      topModule: Type.String({ description: '顶层模块名（对应 RTL module 名称）' }),
      rtlFiles: Type.Array(Type.String(), { description: 'RTL 文件路径列表' }),
      testModule: Type.Optional(Type.String({ description: 'Cocotb Python 模块名，例如 tests.test_uart（不要带 .py）' })),
      testDir: Type.Optional(Type.String({ description: 'Cocotb 环境根目录，加入 PYTHONPATH' })),
      testcase: Type.Optional(Type.String({ description: '仅运行指定 @cocotb.test 测试，可选' })),
      simulator: Type.Optional(Type.Union([Type.Literal('icarus'), Type.Literal('verilator')], { description: 'Cocotb 后端；Windows 缺省 icarus' })),
      tbCpp: Type.Optional(Type.String({ description: 'mode=cpp 时的 C++ 测试台路径' })),
      trace: Type.Optional(Type.Boolean({ description: '是否生成波形，缺省 true' })),
      rtlCoverage: Type.Optional(Type.Boolean({ description: 'Verilator 后端是否采集 RTL 行、条件/表达式、翻转和 FSM 覆盖率；缺省 true' })),
      functionalCoverageFile: Type.Optional(Type.String({ description: '功能覆盖率 JSON 路径；测试也可读取 MOONGLASS_FUNCTIONAL_COVERAGE_FILE 环境变量写入默认路径' })),
      timeoutSec: Type.Optional(Type.Number({ description: '编译和仿真总超时秒数，缺省 300' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const topModule = params.topModule as string
      const rtlFiles = (params.rtlFiles as string[]).map((file) => resolve(ctx.cwd, file))
      const mode = (params.mode as 'cocotb' | 'cpp' | undefined) ?? 'cocotb'
      const tbCpp = params.tbCpp ? resolve(ctx.cwd, params.tbCpp as string) : undefined
      const trace = params.trace as boolean | undefined ?? true

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

      try {
        const resultDir = resolve(ctx.cwd, 'verification', 'results', topModule)
        const result = mode === 'cocotb'
          ? await runCocotbSimulation({
              topModule,
              rtlFiles,
              testModule: params.testModule as string,
              testDir: resolve(ctx.cwd, (params.testDir as string | undefined) ?? `verification/${topModule}_tb`),
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
          '',
          '### 输出日志',
          '```',
          result.log.slice(0, 3000),
          '```',
        ]

        if (result.vcdPath) {
          report.push('', '### 波形查看', '', `gtkwave ${result.vcdPath}`)
        }

        if (!result.passed) {
          report.push('', '### 调试建议', '', '1. 检查 RTL 语法错误', '2. 确认测试台端口连接正确', '3. 查看完整编译日志', '4. 用 read_verilog 确认端口定义')
        }

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
            coverageReportPath: result.coverageReportPath
          },
          isError: !result.passed
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `仿真执行失败: ${message}` }],
          isError: true,
          details: {}
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
    description: '调用 Yosys 完成逻辑综合，输出门级 Verilog 网表、JSON 网表、日志和 Markdown 报告。无 Liberty 时报告通用单元数；提供 Liberty 时执行工艺映射并尝试解析面积和 ABC 延迟。',
    promptSnippet: 'Run Yosys logic synthesis and generate netlist and reports',
    promptGuidelines: 'Pass SRAM blackbox views in libraryFiles, never behavioral/physical views. Report macro PPA separately from Yosys standard-cell area.',
    parameters: Type.Object({
      rtlFiles: Type.Optional(Type.Array(Type.String(), { description: 'RTL 文件列表；缺省时扫描工作区' })),
      libraryFiles: Type.Optional(Type.Array(Type.String(), { description: '宏/库 blackbox Verilog；使用 read_verilog -lib' })),
      topModule: Type.String({ description: '顶层模块名称' }),
      sdcFile: Type.Optional(Type.String({ description: 'SDC 文件路径' })),
      targetLibrary: Type.Optional(Type.String({ description: 'Liberty .lib 工艺库路径；缺省使用 MoonGlass 工艺库索引选定的默认库，未配置则执行通用综合' })),
      outputDir: Type.Optional(Type.String({ description: '输出目录，缺省为 imp/synthesis' })),
      outputName: Type.Optional(Type.String({ description: '输出文件名前缀，缺省为顶层模块名' })),
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
              `**警告**: ${result.warnings.length}`
            ].join('\n')
          }],
          details: result
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
    promptGuidelines: 'Use ranked scenarios to choose tests. Do not invent RTL facts or generate arbitrary Cartesian products.',
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const artifacts = buildVerificationIntelligence(ctx.cwd)
      const state = artifacts.verificationState
      const top = state.scenarios.slice(0, 10)
      return {
        content: [{ type: 'text', text: `## Verification Intelligence\n\n- Requirement：${artifacts.requirementModel.requirements.length}\n- RTL Structural Fact：${artifacts.structuralModel.facts.length}\n- Risk Marker：${artifacts.risks.length}\n- Scenario：${state.scenarioCount}\n- Critical Open：${state.criticalOpen.length}\n- RTL Hash：${state.rtlHash}\n\n### 当前最高优先级\n${top.length ? top.map((item) => `- ${item.id} [${item.status}] priority=${item.priority}：${item.title}`).join('\n') : '- 未识别到 Scenario'}\n\n报告：${artifacts.paths.report}` }],
        details: { paths: artifacts.paths, scenarioCount: state.scenarioCount, criticalOpen: state.criticalOpen, topScenarios: top },
        isError: false
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
      scenarioId: Type.Optional(Type.String({ pattern: '^SCN-[A-F0-9]{8}$', description: '绑定的 Verification Scenario ID' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: 'text', text: `正在运行 Formal ${params.mode ?? 'bmc'}：${params.top}` }] })
      const result = await runFormalVerification({ workspaceDir: ctx.cwd, ...params, signal })
      return { content: [{ type: 'text', text: `## Formal 验证结果\n\n- 状态：${result.status}\n- 模式：${result.mode}\n- 顶层：${result.top}\n- 引擎：${result.engine}\n- 深度：${result.depth}\n- 说明：${result.message}\n- 日志：${result.logPath}\n${result.traces.length ? `- 反例/见证：${result.traces.join(', ')}` : ''}` }], details: result, isError: ['ERROR', 'UNKNOWN'].includes(result.status) }
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
    description: '根据 Scenario 风险、未闭环状态和覆盖率反馈，返回下一批可执行 Cocotb 场景配置与预算。',
    promptSnippet: 'Select the next evidence-driven scenario batch',
    promptGuidelines: 'Implement or reuse the named sequence and checkers. Write scenario_hits.json after execution, then rebuild intelligence.',
    parameters: Type.Object({ limit: Type.Optional(Type.Number({ minimum: 1, maximum: 12 })) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const artifacts = buildVerificationIntelligence(ctx.cwd)
      const plans = artifacts.verificationState.executionPlan.slice(0, Number(params.limit ?? 5))
      return {
        content: [{ type: 'text', text: `## 下一批验证任务\n\n${plans.map((item, index) => `${index + 1}. ${item.scenarioId} · ${item.sequence} · ${item.iterations} 次 / ${item.budgetSeconds}s\n   - ${item.reason}`).join('\n') || '当前没有待执行的 Scenario。'}\n\n机器可读计划：verification/intelligence/scenario-execution-plan.json` }],
        details: { plans, path: artifacts.paths.executionPlan },
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
