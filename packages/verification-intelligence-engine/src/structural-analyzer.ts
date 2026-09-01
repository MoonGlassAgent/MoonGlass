import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import type { ClockResetDomain, Confidence, ControlFlowEdge, ControlFlowNode, ConeOfInfluence, ProtocolStructure, StateMachine, StructuralFact, StructuralModel, RegisterWriter, TemporalDependency } from './types.ts'

interface AnalyzeInput { workspace: string; files: string[]; rtlHash: string; featuresOf: (text: string) => string[] }

function lineOf(text: string, index: number): number { return text.slice(0, Math.max(0, index)).split(/\r?\n/).length }
function executable(name: string): string | undefined {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const found = spawnSync(command, [name], { encoding: 'utf-8', windowsHide: true })
  const located = found.status === 0 ? found.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined
  if (located) return located
  if (process.platform === 'win32') {
    const candidate = join(process.env.USERPROFILE ?? '', 'oss-cad-suite', 'oss-cad-suite', 'bin', `${name}.exe`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
function analyzerEnv(tool: string): NodeJS.ProcessEnv {
  const bin = dirname(tool); const lib = join(bin, '..', 'lib'); const selected = new Set([resolve(bin).toLowerCase(), resolve(lib).toLowerCase()])
  const retained = (process.env.PATH ?? '').split(delimiter).filter(Boolean).filter((entry) => !selected.has(resolve(entry).toLowerCase())).filter((entry) => {
    if (process.platform !== 'win32') return true
    return !['libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll'].some((name) => existsSync(join(entry, name)))
  })
  return { ...process.env, PATH: [bin, lib, ...retained].join(delimiter) }
}

export function analyzeStructure(input: AnalyzeInput): StructuralModel {
  const facts: StructuralFact[] = []
  const stateMachines: StateMachine[] = []
  const registerWriters: RegisterWriter[] = []
  const clockResetDomains: ClockResetDomain[] = []
  const temporalDependencies: TemporalDependency[] = []
  const controlNodes: ControlFlowNode[] = []
  const controlEdges: ControlFlowEdge[] = []
  const protocols: ProtocolStructure[] = []
  const addFact = (module: string, object: string, factType: string, evidence: string, file: string, line: number, confidence: Confidence = 'high'): string => {
    const id = `RTL-F-${facts.length + 1}`
    facts.push({ id, module, object, factType, features: [], evidence, kind: 'RTL_FACT', confidence, source: { file, line } })
    return id
  }
  for (const absolute of input.files) {
    const text = readFileSync(absolute, 'utf-8')
    const file = relative(input.workspace, absolute)
    const moduleName = /\bmodule\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? basename(absolute).replace(/\.(?:v|sv)$/i, '')
    const identifiers = [...new Set(text.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])]
    const protocol = identifiers.some((name) => /\b(?:awvalid|arvalid|wvalid|bvalid|rvalid|awaddr|araddr)\b/i.test(name)) ? 'AXI'
      : identifiers.some((name) => /\b(?:psel|penable|pready|paddr)\b/i.test(name)) ? 'APB'
        : identifiers.some((name) => /\b(?:htrans|hready|haddr|hresp)\b/i.test(name)) ? 'AHB'
          : identifiers.some((name) => /(?:^|_)valid$/i.test(name)) && identifiers.some((name) => /(?:^|_)ready$/i.test(name)) ? 'READY_VALID'
            : identifiers.some((name) => /(?:fifo|full|empty)/i.test(name)) ? 'FIFO' : undefined
    if (protocol) protocols.push({ id: `PROTO-${protocols.length + 1}`, module: moduleName, protocol, signals: identifiers.filter((name) => /(?:valid|ready|addr|data|resp|last|len|size|burst|sel|enable|full|empty)/i.test(name)).slice(0, 80), rules: protocol === 'AXI' || protocol === 'READY_VALID' ? ['VALID 拉高后在握手前保持', '发生 backpressure 时 payload 保持稳定', '每个请求最终完成或明确超时/错误'] : protocol === 'APB' ? ['SETUP 后进入 ACCESS', 'PSEL/PENABLE/PREADY 时序合法'] : protocol === 'AHB' ? ['HTRANS/HREADY 传输推进合法', 'HRESP 错误可观察'] : ['满/空边界不溢出、不下溢'], source: { file, line: 1 } })
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
    // AST 是引擎中间产物（实测可达 10MB 级），落到系统临时目录而非工作区，
    // 避免 Agent 把全量 AST 读入上下文；解析消费后立即删除，失败时保留路径供调试。
    const astDir = join(tmpdir(), 'moonglass-slang-ast')
    mkdirSync(astDir, { recursive: true })
    const astPath = join(astDir, `slang-ast-${input.rtlHash.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'unknown'}.json`)
    const env = analyzerEnv(slang)
    const run = spawnSync(slang, ['--ast-json', astPath, '--ast-json-source-info', '--ignore-unknown-modules', ...input.files], { cwd: input.workspace, encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env })
    if (run.status === 0 && existsSync(astPath)) {
      const version = spawnSync(slang, ['--version'], { encoding: 'utf-8', windowsHide: true, env }).stdout.trim()
      analyzer = { engine: 'slang-ast', version, limitations: ['MoonGlass 消费 elaborated AST 的过程块、条件、case、赋值与符号引用，并与保守结构抽取交叉补充', '未启用 ast-json-detailed-types，避免大型 class/UVM 工程输出膨胀', 'COI 为静态信号依赖锥，不替代专业 CDC/RDC 或完整形式化语义分析'] }
      addFact('$design', '$root', 'SLANG_ELABORATED_AST', `Slang elaboration 完成：${version}`, astPath, 1)
      const astSize = statSync(astPath).size
      let consumed = false
      try {
        if (astSize > 128 * 1024 * 1024) {
          analyzer.limitations.unshift(`Slang AST 为 ${Math.round(astSize / 1024 / 1024)}MB，超过 128MB 消费上限；使用结构抽取，AST 临时保留于 ${astPath} 供调试`)
          analyzer.astPath = astPath
        } else {
          const ast = JSON.parse(readFileSync(astPath, 'utf-8')) as Record<string, unknown>
          const symbolName = (value: unknown): string => typeof value === 'string' ? value.replace(/^\d+\s+/, '') : ''
          const namesIn = (value: unknown): string[] => {
            if (!value || typeof value !== 'object') return []
            const node = value as Record<string, unknown>; const own = node.kind === 'NamedValue' ? [symbolName(node.symbol)] : []
            return [...new Set([...own, ...Object.values(node).flatMap(namesIn)].filter(Boolean))]
          }
          const visit = (value: unknown, module = '$root', parentControl?: string): void => {
            if (!value || typeof value !== 'object') return
            if (Array.isArray(value)) { for (const item of value) visit(item, module, parentControl); return }
            const node = value as Record<string, unknown>; const kind = String(node.kind ?? '')
            const activeModule = kind === 'InstanceBody' && typeof node.name === 'string' ? node.name : module
            const rawFile = String(node.source_file_start ?? node.source_file ?? '')
            const source = { file: rawFile ? relative(input.workspace, rawFile) : astPath, line: Number(node.source_line_start ?? node.source_line ?? 1) }
            let activeControl = parentControl
            if (kind === 'ProceduralBlock' || kind === 'Conditional' || kind === 'Case') {
              const controlKind: ControlFlowNode['kind'] = kind === 'ProceduralBlock' ? 'ENTRY' : kind === 'Case' ? 'CASE' : 'CONDITION'
              const id = `CFG-${controlNodes.length + 1}`; controlNodes.push({ id, module: activeModule, kind: controlKind, label: kind === 'ProceduralBlock' ? String(node.procedureKind ?? kind) : namesIn(node.conditions ?? node.expr).join(' & ') || kind, source })
              if (parentControl) controlEdges.push({ from: parentControl, to: id, relation: kind === 'Conditional' ? 'TRUE' : kind === 'Case' ? 'CASE_ITEM' : 'NEXT' })
              activeControl = id
            }
            if (kind === 'Assignment') {
              const sink = namesIn(node.left)[0]; const sources = namesIn(node.right).filter((name) => name !== sink)
              const id = `CFG-${controlNodes.length + 1}`; controlNodes.push({ id, module: activeModule, kind: 'ASSIGNMENT', label: `${sink} <= ${sources.join(', ') || 'constant'}`, source })
              if (activeControl) controlEdges.push({ from: activeControl, to: id, relation: 'NEXT' })
              for (const sourceName of sources) if (!temporalDependencies.some((item) => item.module === activeModule && item.from === sourceName && item.to === sink)) temporalDependencies.push({ id: `TDEP-${temporalDependencies.length + 1}`, module: activeModule, from: sourceName, to: sink, relation: 'DEPENDS_ON', source })
              if (sink) addFact(activeModule, sink, 'SLANG_AST_ASSIGNMENT', `Slang AST 确认写入 ${sink}，数据源：${sources.join(', ') || 'constant'}`, source.file, source.line)
            }
            for (const child of Object.values(node)) visit(child, activeModule, activeControl)
          }
          visit(ast)
          consumed = true
          analyzer.limitations.push('Slang AST 为临时中间产物，解析消费后已删除，不写入工作区')
        }
      } finally {
        if (consumed) rmSync(astPath, { force: true })
      }
    } else {
      mkdirSync(join(input.workspace, 'verification', 'intelligence'), { recursive: true })
      writeFileSync(join(input.workspace, 'verification', 'intelligence', 'slang-diagnostics.log'), `${run.stdout}\n${run.stderr}`, 'utf-8')
      analyzer.limitations.unshift('Slang 已安装但 elaboration 失败，已自动回退；详见 slang-diagnostics.log')
      if (existsSync(astPath)) {
        analyzer.astPath = astPath
        analyzer.limitations.push(`Slang 失败时的部分 AST 输出保留于 ${astPath} 供调试`)
      }
    }
  }
  const dependenciesBySink = new Map<string, TemporalDependency[]>()
  for (const dependency of temporalDependencies) { const key = `${dependency.module}.${dependency.to}`; dependenciesBySink.set(key, [...(dependenciesBySink.get(key) ?? []), dependency]) }
  const reverse = new Map<string, Set<string>>()
  for (const dependency of temporalDependencies) { const sink = `${dependency.module}.${dependency.to}`; const source = `${dependency.module}.${dependency.from}`; if (!reverse.has(sink)) reverse.set(sink, new Set()); reverse.get(sink)!.add(source) }
  const conesOfInfluence: ConeOfInfluence[] = [...dependenciesBySink.entries()].map(([sink, dependencies]) => {
    const directSources = [...new Set(dependencies.map((item) => `${item.module}.${item.from}`))]; const visited = new Set(directSources); let frontier = [...directSources]; let depth = 1
    while (frontier.length && depth < 8) { const next = frontier.flatMap((item) => [...(reverse.get(item) ?? [])]).filter((item) => !visited.has(item)); next.forEach((item) => visited.add(item)); frontier = next; if (next.length) depth++ }
    return { sink, directSources, transitiveSources: [...visited], depth }
  }).sort((a, b) => b.transitiveSources.length - a.transitiveSources.length)
  for (const fact of facts) fact.features = input.featuresOf(`${fact.object} ${fact.evidence}`)
  return { version: 2, generatedAt: new Date().toISOString(), rtlHash: input.rtlHash, sourceFiles: input.files.map((file) => relative(input.workspace, file)), facts, analyzer, stateMachines, registerWriters, clockResetDomains, temporalDependencies, controlFlow: { nodes: controlNodes, edges: controlEdges }, conesOfInfluence, protocols }
}
