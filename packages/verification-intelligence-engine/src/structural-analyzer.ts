import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { ClockResetDomain, Confidence, StateMachine, StructuralFact, StructuralModel, RegisterWriter, TemporalDependency } from './types.ts'

interface AnalyzeInput { workspace: string; files: string[]; rtlHash: string; featuresOf: (text: string) => string[] }

function lineOf(text: string, index: number): number { return text.slice(0, Math.max(0, index)).split(/\r?\n/).length }
function executable(name: string): string | undefined {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const found = spawnSync(command, [name], { encoding: 'utf-8', windowsHide: true })
  return found.status === 0 ? found.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined
}

export function analyzeStructure(input: AnalyzeInput): StructuralModel {
  const facts: StructuralFact[] = []
  const stateMachines: StateMachine[] = []
  const registerWriters: RegisterWriter[] = []
  const clockResetDomains: ClockResetDomain[] = []
  const temporalDependencies: TemporalDependency[] = []
  const addFact = (module: string, object: string, factType: string, evidence: string, file: string, line: number, confidence: Confidence = 'high'): string => {
    const id = `RTL-F-${facts.length + 1}`
    facts.push({ id, module, object, factType, features: [], evidence, kind: 'RTL_FACT', confidence, source: { file, line } })
    return id
  }
  for (const absolute of input.files) {
    const text = readFileSync(absolute, 'utf-8')
    const file = relative(input.workspace, absolute)
    const moduleName = /\bmodule\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? basename(absolute).replace(/\.(?:v|sv)$/i, '')
    const always = /always(?:_ff|_comb|_latch)?\s*@?\s*\(([^)]*)\)\s*(?:begin)?([\s\S]*?)(?=\bend\b\s*(?:else|always|endmodule)|\balways(?:_ff|_comb|_latch)?\b|\bendmodule\b)/gi
    for (const block of text.matchAll(always)) {
      const sensitivity = block[1] ?? ''
      const body = block[2] ?? ''
      const clockMatch = /(posedge|negedge)\s+([A-Za-z_$][\w$]*)/.exec(sensitivity)
      const resetMatch = /(?:posedge|negedge)\s+([A-Za-z_$][\w$]*(?:rst|reset)[\w$]*)/i.exec(sensitivity)
      const assignments = [...body.matchAll(/\b([A-Za-z_$][\w$]*(?:\[[^\]]+\])?)\s*<=?\s*([^;]+);/g)]
      const regs = [...new Set(assignments.map((m) => m[1].replace(/\[.*$/, '')))]
      if (clockMatch) clockResetDomains.push({ id: `DOMAIN-${clockResetDomains.length + 1}`, module: moduleName, clock: clockMatch[2], reset: resetMatch?.[1], edge: clockMatch[1], registers: regs, source: { file, line: lineOf(text, block.index ?? 0) } })
      for (const assignment of assignments) {
        const register = assignment[1].replace(/\[.*$/, '')
        const before = body.slice(0, assignment.index ?? 0)
        const conditions = [...before.matchAll(/\b(?:if|else\s+if)\s*\(([^)]*)\)/g)].slice(-4).map((m) => m[1].trim())
        registerWriters.push({ id: `WRITER-${registerWriters.length + 1}`, module: moduleName, register, conditions, priority: conditions.length, clock: clockMatch?.[2], reset: resetMatch?.[1], source: { file, line: lineOf(text, (block.index ?? 0) + (assignment.index ?? 0)) } })
        addFact(moduleName, register, 'REGISTER_WRITER', `${register} 在 ${conditions.join(' -> ') || '无显式条件'} 下写入`, file, lineOf(text, (block.index ?? 0) + (assignment.index ?? 0)))
        for (const token of [...new Set((assignment[2].match(/\b[A-Za-z_$][\w$]*\b/g) ?? []).filter((x) => x !== register))].slice(0, 16)) {
          temporalDependencies.push({ id: `TDEP-${temporalDependencies.length + 1}`, module: moduleName, from: token, to: register, relation: clockMatch ? 'PRECEDES' : 'DEPENDS_ON', source: { file, line: lineOf(text, (block.index ?? 0) + (assignment.index ?? 0)) } })
        }
        for (const token of [...new Set(conditions.flatMap((condition) => condition.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []).filter((x) => x !== register))].slice(0, 16)) {
          temporalDependencies.push({ id: `TDEP-${temporalDependencies.length + 1}`, module: moduleName, from: token, to: register, relation: 'CONTROLS', source: { file, line: lineOf(text, (block.index ?? 0) + (assignment.index ?? 0)) } })
        }
      }
    }
    for (const match of text.matchAll(/\b(?:case|casez|casex)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)([\s\S]*?)\bendcase\b/gi)) {
      const states = [...match[2].matchAll(/^\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*:/gm)].flatMap((m) => m[1].split(',').map((x) => x.trim())).filter((x) => !/^default$/i.test(x))
      stateMachines.push({ id: `FSM-${stateMachines.length + 1}`, module: moduleName, stateObject: match[1], states: [...new Set(states)], source: { file, line: lineOf(text, match.index ?? 0) } })
      addFact(moduleName, match[1], 'STATE_MACHINE', `状态对象 ${match[1]}，识别到 ${states.length} 个状态分支`, file, lineOf(text, match.index ?? 0))
    }
    const priority = /\bif\s*\([\s\S]{0,1600}?\belse\s+if\s*\(/i.exec(text)
    if (priority) addFact(moduleName, moduleName, 'PRIORITY_CHAIN', '识别到 if/else-if 控制优先级', file, lineOf(text, priority.index), 'medium')
  }

  let analyzer: StructuralModel['analyzer'] = { engine: 'moonglass-structural-fallback', limitations: ['未检测到 Slang，语义来自结构化保守抽取', '复杂宏、generate 与 class/UVM 结构需要 Slang 提升精度', '结构风险不等同于 RTL bug'] }
  const slang = executable('slang')
  if (slang && input.files.length) {
    const astPath = join(input.workspace, 'verification', 'intelligence', 'slang-ast.json')
    mkdirSync(dirname(astPath), { recursive: true })
    const run = spawnSync(slang, ['--ast-json', astPath, '--ast-json-source-info', '--ignore-unknown-modules', ...input.files], { cwd: input.workspace, encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    if (run.status === 0 && existsSync(astPath)) {
      const version = spawnSync(slang, ['--version'], { encoding: 'utf-8', windowsHide: true }).stdout.trim()
      analyzer = { engine: 'slang-ast', version, astPath: relative(input.workspace, astPath), limitations: ['MoonGlass 当前从 AST 建立源位置与 elaboration 可信锚点，CFG/DFG 继续由结构抽取补充', '未启用 ast-json-detailed-types，避免大型 class/UVM 工程输出膨胀'] }
      addFact('$design', '$root', 'SLANG_ELABORATED_AST', `Slang elaboration 完成：${version}`, relative(input.workspace, astPath), 1)
    } else {
      writeFileSync(join(input.workspace, 'verification', 'intelligence', 'slang-diagnostics.log'), `${run.stdout}\n${run.stderr}`, 'utf-8')
      analyzer.limitations.unshift('Slang 已安装但 elaboration 失败，已自动回退；详见 slang-diagnostics.log')
    }
  }
  for (const fact of facts) fact.features = input.featuresOf(`${fact.object} ${fact.evidence}`)
  return { version: 2, generatedAt: new Date().toISOString(), rtlHash: input.rtlHash, sourceFiles: input.files.map((file) => relative(input.workspace, file)), facts, analyzer, stateMachines, registerWriters, clockResetDomains, temporalDependencies }
}
