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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
import { runVerilatorSimulation } from './eda-bridge/simulation'

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
  const yosysPath = await locateTool(YOSYS_CANDIDATES)
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

// 递归收集 RTL 文件
/** 排除的生成文件/目录名模式 */
const EXCLUDED_DIRS = /^(obj_dir|__pycache__|node_modules|build|sim_build|04_verification)$/
const EXCLUDED_FILES = /^(_+)?(synth_|output_|result_|merged_|combined_|tmp_|temp_)/i

function collectRtlFiles(dir: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || EXCLUDED_DIRS.test(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...collectRtlFiles(full))
    } else if (/\.(v|sv)$/i.test(e.name) && !EXCLUDED_FILES.test(e.name)) {
      out.push(full)
    }
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

      const files = collectRtlFiles(dir)
      if (files.length === 0) {
        return {
          content: [{ type: 'text', text: `工作目录 ${dir} 中未发现 RTL 文件（*.v/*.sv）。` }],
          details: { files: [] }
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
        details: { files: modules }
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
      outputPath: Type.Optional(Type.String({ description: '输出 .cpp 文件路径（缺省为与 rtlFile 同目录下 sim_main.cpp）' })),
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
      const outPath = (params.outputPath as string | undefined) ??
        rtlFile.replace(/\.[^.]+$/, '_sim_main.cpp')

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
  // 工具 6: run_simulation — Verilator 编译并运行仿真
  // ============================================================
  pi.registerTool({
    name: 'run_simulation',
    label: 'Run Simulation',
    description: '使用 Verilator 编译 RTL + C++ 测试台并运行仿真。支持波形输出（VCD）。返回编译日志、运行输出、通过/失败状态和 VCD 文件路径。',
    promptSnippet: 'Compile and run Verilator simulation with RTL and testbench',
    promptGuidelines: 'Use run_simulation after writing RTL and generating a testbench. The tool handles verilator --cc --build --exe and runs the simulation binary.',
    parameters: Type.Object({
      topModule: Type.String({ description: '顶层模块名（对应 RTL module 名称）' }),
      rtlFiles: Type.Array(Type.String(), { description: 'RTL 文件路径列表' }),
      tbCpp: Type.String({ description: 'C++ 测试台文件路径' }),
      trace: Type.Optional(Type.Boolean({ description: '是否生成 VCD 波形（缺省 true，需测试台和 verilator 均支持）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const topModule = params.topModule as string
      const rtlFiles = params.rtlFiles as string[]
      const tbCpp = params.tbCpp as string
      const trace = params.trace as boolean | undefined ?? true

      // 验证输入文件
      const missing: string[] = []
      if (!existsSync(tbCpp)) missing.push(tbCpp)
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

      // 检查 verilator 可用
      const verilatorPath = await locateTool(VERILATOR_CANDIDATES)
      if (!verilatorPath) {
        return {
          content: [{ type: 'text', text: 'Verilator 未安装或不在 PATH 中。\n请安装 oss-cad-suite 或系统包管理器安装 verilator。' }],
          isError: true,
          details: {}
        }
      }

      try {
        const result = await runVerilatorSimulation({
          topModule,
          tbCpp,
          rtlFiles,
          trace,
          signal
        })

        const report = [
          `## 仿真结果 — ${topModule}`,
          '',
          `**结果**: ${result.passed ? '✅ 通过' : '❌ 失败'}`,
          `**VCD 波形**: ${result.vcdPath ? `✅ ${result.vcdPath}` : '❌ 未生成'}`,
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
            vcdPath: result.vcdPath
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
  // 工具 7: run_cdc_check — 时钟域交叉（CDC）静态检查
  // ============================================================
  pi.registerTool({
    name: 'run_cdc_check',
    label: 'Run CDC Check',
    description: '对工作区 RTL 代码进行时钟域交叉（Clock Domain Crossing）静态分析。检测多时钟域设计、跨域信号路径，并检查是否存在标准同步器（2-flop / async FIFO）。输出 CDC 报告与修复建议。',
    promptSnippet: 'Run clock domain crossing analysis on the RTL design',
    promptGuidelines: 'Use run_cdc_check in multi-clock designs to find CDC issues. Always use 2-flop synchronizers for single-bit CDC and async FIFOs for multi-bit CDC.',
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: '扫描目录（缺省为 cwd）' }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const dir = (params.directory as string | undefined) ?? ctx.cwd
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
}
