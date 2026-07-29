/**
 * MoonGlass 芯片专用工具集（Pi 扩展）
 *
 * 以 Pi Coding Agent 扩展形式注册芯片 EDA 工具，让 Agent 可在对话中
 * 调用 lint 检查、可综合性检查等芯片专用能力。
 *
 * 加载方式：AgentService spawn pi 时通过 `-e` 加载本文件。
 * 设计原则：自包含——仅依赖 Node 内置模块（child_process / path / fs），
 * 不依赖 @moonglass/eda-bridge 等 workspace 包（pi 子进程无法解析）。
 *
 * 本文件复制到 userData/moonglass/pi-bridge/ 后由 pi 的 jiti 加载。
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const execFileAsync = promisify(execFile)

// ============================================================
// 工具定位与执行
// ============================================================

const EXEC_TIMEOUT_MS = 60_000
const MAX_BUFFER = 8 * 1024 * 1024

/** Windows 上 oss-cad-suite 的 verilator 是无扩展名脚本，需回退到 verilator_bin.exe */
const VERILATOR_CANDIDATES = ['verilator', 'verilator_bin.exe']

/** 在 PATH 中定位可执行文件（支持候选名列表） */
async function locateTool(names: string[]): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync(locator, [name], { timeout: 5000 })
      const found = stdout.trim().split(/\r?\n/)[0]
      if (found) return found
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null
}

/** 构造工具执行环境：把工具所在 bin 与同级 lib 提到 PATH 最前（oss-cad-suite DLL 依赖） */
function toolEnv(toolPath: string): NodeJS.ProcessEnv {
  const bin = dirname(toolPath)
  return {
    ...process.env,
    PATH: `${bin}${delimiter}${join(bin, '..', 'lib')}${delimiter}${process.env.PATH ?? ''}`
  }
}

/** execFile 的宽松封装——非零退出不抛异常，支持 AbortSignal 取消 */
function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd, args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env, signal },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ stdout: '', stderr: `工具未找到: ${cmd}`, code: null })
          return
        }
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: err ? ((err as { code?: number }).code ?? 1) : 0
        })
      }
    )
  })
}

/** 尝试多个候选名执行 */
async function runWithFallback(candidates: string[], args: string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null; cmd: string }> {
  for (const cmd of candidates) {
    try {
      const result = await run(cmd, args, env, signal)
      return { ...result, cmd }
    } catch {
      continue
    }
  }
  return { stdout: '', stderr: `所有候选均不可用: ${candidates.join(', ')}`, code: null, cmd: '' }
}

// ============================================================
// 工具特定逻辑
// ============================================================

// ---- Verible/Verilator Lint ----

// verible 输出格式：file:line:col: message [rule-name]
const VERIBLE_LINE = /^.+?:(\d+):(\d+):\s*(.+?)\s*\[([a-z0-9-]+)\]\s*$/
// verilator 输出格式：%Error[-CODE]: file:line:col: message / %Warning-CODE: file:line:col: message
const VERILATOR_LINE = /^%(Error|Warning)(?:-([A-Z0-9_]+))?:\s*.+?:(\d+):(\d+):\s*(.+)$/

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
      line: Number(m[1]),
      column: Number(m[2]),
      severity: 'error',
      rule: m[4],
      message: m[3]
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
      line: Number(m[3]),
      column: Number(m[4]),
      severity: m[1] === 'Error' ? 'error' : 'warning',
      rule: m[2] ?? (m[1] === 'Error' ? 'error' : 'warning'),
      message: m[5]
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
  const { stdout, stderr } = await runWithFallback(VERILATOR_CANDIDATES, ['--lint-only', '-Wno-fatal', filePath], undefined, signal)
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

async function runYosysCheck(rtlFiles: string[], topModule?: string, signal?: AbortSignal): Promise<SynthResult> {
  const yosysPath = await locateTool(process.platform === 'win32' ? ['yosys.exe', 'yosys'] : ['yosys'])
  if (!yosysPath) throw new Error('Yosys 未安装或不在 PATH 中')

  const readCmd = `read_verilog -sv ${rtlFiles.map((f) => `"${f}"`).join(' ')}`
  const hierarchyCmd = topModule ? `hierarchy -top ${topModule}` : 'hierarchy -auto-top'
  const script = `${readCmd}; ${hierarchyCmd}; check; stat`

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
      // 检查是否有参数列表
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

// 递归收集 RTL 文件
function collectRtlFiles(dir: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...collectRtlFiles(full))
    else if (/\.(v|sv)$/i.test(e.name)) out.push(full)
  }
  return out
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

export default function (pi: ExtensionAPI): void {
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
    promptGuidelines: 'Use check_synthesizability after lint passes to verify the RTL can be synthesized. Fix all errors before proceeding to next phase.',
    parameters: Type.Object({
      rtlFiles: Type.Array(Type.String(), { description: '需要检查的 RTL 文件路径列表' }),
      topModule: Type.Optional(Type.String({ description: '顶层模块名称（可选，缺省自动识别）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rtlFiles = params.rtlFiles as string[]
      const topModule = params.topModule as string | undefined

      // 验证所有文件存在
      const missing = rtlFiles.filter((f) => !existsSync(f))
      if (missing.length > 0) {
        return {
          content: [{ type: 'text', text: `错误：以下文件不存在:\n${missing.map((f) => `  - ${f}`).join('\n')}` }],
          isError: true,
          details: {}
        }
      }

      try {
        const result = await runYosysCheck(rtlFiles, topModule, signal)

        const errorCount = result.issues.filter((i) => i.severity === 'error').length
        const warningCount = result.issues.filter((i) => i.severity === 'warning').length

        const report = [
          `## Synthesizability Check`,
          `**文件**: ${rtlFiles.join(', ')}`,
          `**顶层**: ${topModule ?? '自动识别'}`,
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
    description: '递归扫描工作目录，收集所有 Verilog/SystemVerilog 文件（*.v/*.sv），返回文件路径列表及每个文件的顶层模块名。',
    promptSnippet: 'Scan project directory for RTL source files',
    promptGuidelines: 'Use collect_rtl_files to discover all RTL files in the workspace before running lint or synthesizability checks.',
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: '扫描目录（缺省为 cwd）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const dir = (params.directory as string | undefined) ?? ctx.cwd
      if (!existsSync(dir)) {
        return {
          content: [{ type: 'text', text: `错误：目录不存在 — ${dir}` }],
          isError: true,
          details: {}
        }
      }

      const files = collectRtlFiles(dir)
      if (files.length === 0) {
        return {
          content: [{ type: 'text', text: `工作目录 ${dir} 中未发现 RTL 文件（*.v/*.sv）。` }],
          details: { files: [] }
        }
      }

      // 尝试提取每个文件的模块名（可选，快速解析不阻塞整体）
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
        details: { files: modules }
      }
    }
  })
}
