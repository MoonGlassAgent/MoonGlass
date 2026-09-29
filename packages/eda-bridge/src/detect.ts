/**
 * EDA 工具探测
 *
 * 在系统 PATH 中探测常用 EDA 工具并尝试获取版本号。
 * 本模块为骨架阶段唯一提供真实功能的 EDA 能力。
 */

import type { ToolDetection } from '@shared/types'
import { locateTool, run, toolEnv } from './tool-runner'
import { COCOTB_VERSION_RANGE, isCocotbVersionCompatible, TOOLCHAIN_MANIFEST } from './toolchain-manifest'

type Probe = Omit<ToolDetection, 'found' | 'path' | 'version'> & {
  candidates: string[]
  versionArgs: string[]
}

const OSS_CAD = 'oss-cad-suite'
const TOOL_PROBES: Probe[] = [
  { tool: 'Node.js', candidates: ['node'], versionArgs: ['--version'], category: 'runtime', importance: 'required', description: 'Agent 与工程脚本运行时', installUrl: 'https://nodejs.org/en/download' },
  { tool: 'npm', candidates: ['npm'], versionArgs: ['--version'], category: 'runtime', importance: 'required', description: 'Node.js 包管理器', installUrl: 'https://nodejs.org/en/download' },
  { tool: 'pnpm', candidates: ['pnpm'], versionArgs: ['--version'], category: 'runtime', importance: 'recommended', description: 'MoonGlass 工作区依赖管理', installUrl: 'https://pnpm.io/installation' },
  { tool: 'Python', candidates: ['python', 'python3'], versionArgs: ['--version'], category: 'runtime', importance: 'required', description: '技能脚本与 Cocotb 运行时', installUrl: 'https://www.python.org/downloads/' },
  { tool: 'pip', candidates: ['pip', 'pip3'], versionArgs: ['--version'], category: 'runtime', importance: 'recommended', description: 'Python 验证依赖管理', installUrl: 'https://pip.pypa.io/en/stable/installation/' },
  { tool: 'Git', candidates: ['git'], versionArgs: ['--version'], category: 'build', importance: 'required', description: '版本管理与开源资源下载', installUrl: 'https://git-scm.com/downloads' },
  { tool: 'C/C++ 编译器', candidates: ['clang', 'gcc'], versionArgs: ['--version'], category: 'build', importance: 'recommended', description: 'Verilator C++ 仿真构建', installId: OSS_CAD },
  { tool: 'Make', candidates: ['make', 'mingw32-make'], versionArgs: ['--version'], category: 'build', importance: 'recommended', description: 'Verilator 构建流程', installId: OSS_CAD },
  { tool: 'Yosys', candidates: ['yosys.exe', 'yosys'], versionArgs: ['-V'], category: 'eda', importance: 'required', description: 'RTL 综合、结构分析与 Formal 模型生成', builtin: true },
  { tool: 'Verilator', candidates: ['verilator_bin.exe', 'verilator'], versionArgs: ['--version'], category: 'eda', importance: 'recommended', description: 'Lint 与高速仿真', installId: OSS_CAD },
  { tool: 'Icarus Verilog', candidates: ['iverilog'], versionArgs: ['-V'], category: 'verification', importance: 'required', description: 'Windows 默认 Cocotb 仿真器', installId: OSS_CAD },
  { tool: 'Verible', candidates: ['verible-verilog-lint'], versionArgs: ['--version'], category: 'verification', importance: 'recommended', description: 'Verilog/SystemVerilog 语法与风格检查', installId: 'verible', installUrl: 'https://github.com/chipsalliance/verible/releases' },
  { tool: 'Slang', candidates: ['slang.exe', 'slang'], versionArgs: ['--version'], category: 'verification', importance: 'recommended', description: 'SystemVerilog 完整解析、展开与验证智能 AST', builtin: true },
  { tool: 'SymbiYosys', candidates: ['sby.cmd', 'sby.exe', 'sby'], versionArgs: ['--version'], category: 'verification', importance: 'recommended', description: '开源 Formal BMC、证明与可达性验证', builtin: true },
  { tool: 'Yosys-SMTBMC', candidates: ['yosys-smtbmc.cmd', 'yosys-smtbmc.exe', 'yosys-smtbmc'], versionArgs: ['--help'], category: 'verification', importance: 'recommended', description: 'SBY 与 SMT Solver 之间的模型检查执行层', builtin: true },
  { tool: 'Boolector', candidates: ['boolector.exe', 'boolector'], versionArgs: ['--version'], category: 'verification', importance: 'recommended', description: '位向量 Formal 求解器', builtin: true },
  { tool: 'Bitwuzla', candidates: ['bitwuzla.exe', 'bitwuzla'], versionArgs: ['--version'], category: 'verification', importance: 'recommended', description: '备用 SMT 位向量与数组求解器', builtin: true },
  { tool: 'GTKWave', candidates: process.platform === 'win32' ? ['gtkwave.exe', 'gtkwave'] : ['gtkwave'], versionArgs: ['--version'], category: 'verification', importance: 'recommended', description: 'VCD/FST 波形查看', installId: OSS_CAD },
  { tool: 'Cocotb', candidates: ['python', 'python3'], versionArgs: ['-c', 'import cocotb; print(cocotb.__version__)'], category: 'verification', importance: 'required', description: '默认 Python 验证框架', installId: 'python-cocotb' },
  {
    tool: 'OpenSTA',
    candidates: ['sta', 'opensta'],
    versionArgs: ['-version'],
    category: 'physical',
    importance: 'recommended',
    description: process.platform === 'win32'
      ? '门级静态时序分析；Windows 工具包不包含，需通过 WSL2 或 Docker 配置'
      : '门级静态时序分析',
    installUrl: 'https://openroad.readthedocs.io/en/latest/user/Build.html'
  },
  {
    tool: 'OpenROAD',
    candidates: ['openroad'],
    versionArgs: ['-version'],
    category: 'physical',
    importance: 'optional',
    description: process.platform === 'win32'
      ? '物理感知优化与 RTL-to-GDS；Windows 原生不受支持，需使用 WSL2 或 Docker'
      : '物理感知时序优化与 RTL-to-GDS',
    installUrl: 'https://openroad.readthedocs.io/en/latest/user/Build.html'
  }
]

async function probeOne(probe: Probe): Promise<ToolDetection> {
  const toolPath = await locateTool(probe.candidates)
  const metadata = { tool: probe.tool, category: probe.category, importance: probe.importance, description: probe.description, installId: probe.installId, installUrl: probe.installUrl, builtin: probe.builtin }
  if (!toolPath) return { ...metadata, found: false }

  let version: string | undefined
  try {
    const { stdout, stderr, code } = await run(toolPath, probe.versionArgs, toolEnv(toolPath))
    if (code !== 0 && code !== null) return { ...metadata, found: false, path: toolPath }
    version = (stdout || stderr).trim().split(/\r?\n/)[0]
  } catch {
    // 版本获取失败不影响探测结果
  }
  const result: ToolDetection = { ...metadata, found: true, path: toolPath, version }
  // cocotb 版本范围校验（T1）：不兼容时仍判 found（工具存在），但标记 versionCompatible=false
  // 并给出升级指引，由 UI 提示用户按 pin 版本升级。
  if (probe.installId === 'python-cocotb' && version) {
    result.versionCompatible = isCocotbVersionCompatible(version)
    if (!result.versionCompatible) {
      result.versionHint = `当前 cocotb 版本 ${version} 不在支持范围（${COCOTB_VERSION_RANGE}），运行侧依赖 cocotb 2.x API；请执行：pip install --user --upgrade "cocotb==${TOOLCHAIN_MANIFEST['python-cocotb'].pinnedVersion}"`
    }
  }
  return result
}

/** 探测全部已注册的 EDA 工具 */
export async function detectToolchain(): Promise<ToolDetection[]> {
  return Promise.all(TOOL_PROBES.map(probeOne))
}
