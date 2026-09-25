/**
 * Lint 封装（Phase 3 真实现）
 *
 * 引擎策略：优先 verible-verilog-lint；未安装时自动回退
 * verilator --lint-only（-Wno-fatal：Warning 不影响退出码，仅 Error 计入失败）。
 * 两者解析到统一的 LintResult，engine 字段标注实际使用的引擎。
 */

import { readFileSync } from 'node:fs'
import {
  locateTool,
  run,
  runWithFallback,
  toolEnv,
  VERILATOR_CANDIDATES,
  VERIBLE_CANDIDATES
} from './tool-runner'

export interface LintIssue {
  file?: string
  line: number
  column: number
  severity: 'error' | 'warning'
  rule: string
  message: string
}

export interface LintResult {
  passed: boolean
  /** 实际执行检查的的引擎 */
  engine: 'verible' | 'verilator'
  errors: LintIssue[]
  warnings: LintIssue[]
  fixedCode?: string
}

export interface VeribleLintOptions {
  filePath: string
  rulesFile?: string
  autofix?: boolean
}

export interface DesignLintOptions {
  files: string[]
  libraryFiles?: string[]
  topModule?: string
  includeDirs?: string[]
  defines?: string[]
}

async function hasVerible(): Promise<boolean> {
  return (await locateTool(VERIBLE_CANDIDATES)) !== null
}

// verible 输出：file:line:col: message [rule-name]
const VERIBLE_LINE = /^(.+):(\d+):(\d+):\s*(.+?)\s*\[([a-z0-9-]+)\]\s*$/
// verilator 输出：%Error[-CODE]: file:line:col: message / %Warning-CODE: file:line:col: message
const VERILATOR_LINE = /^%(Error|Warning)(?:-([A-Z0-9_]+))?:\s*(.+):(\d+):(\d+):\s*(.+)$/

/**
 * Verilator -Wall 警告升级集：这些类别对应真实硬件缺陷（推断锁存器、多驱动、复位同步/
 * 异步混用、组合环路、case 分支重叠、常量比较越界、位选越界），命中后移入 errors 计入门禁。
 * 刻意不升级 WIDTH/WIDTHTRUNC/WIDTHEXPAND/CASEINCOMPLETE：存量代码命中率过高且多为良性
 * （位宽自适配、优先级 case 缺默认分支的提醒），升级会淹没真实缺陷并阻塞存量项目，
 * 留在 warnings 通道供人工评审。
 */
const VERILATOR_BLOCKING_RULES = new Set([
  'LATCH', 'MULTIDRIVEN', 'SYNCASYNCNET', 'UNOPTFLAT', 'CASEOVERLAP', 'CMPCONST', 'SELRANGE'
])

/** 把升级集命中的 warning 从 warnings 移入 errors（原地修改 parsed）。verible 引擎路径不适用。 */
export function escalateVerilatorWarnings(parsed: { errors: LintIssue[]; warnings: LintIssue[] }): void {
  const remaining: LintIssue[] = []
  for (const warning of parsed.warnings) {
    if (VERILATOR_BLOCKING_RULES.has(warning.rule)) parsed.errors.push(warning)
    else remaining.push(warning)
  }
  parsed.warnings = remaining
}

function parseVerible(output: string): LintIssue[] {
  const issues: LintIssue[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = VERIBLE_LINE.exec(line.trim())
    if (!m) continue
    // verible lint 违规按门禁语义一律计为 error（门禁要求零违规）
    issues.push({
      file: m[1],
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
      file: m[3],
      severity: m[1] === 'Error' ? 'error' : 'warning',
      rule: m[2] ?? (m[1] === 'Error' ? 'error' : 'warning'),
      message: m[6]
    }
    if (issue.severity === 'error') errors.push(issue)
    else warnings.push(issue)
  }
  return { errors, warnings }
}

/** MoonGlass Verilog-2001 规则：内部对象必须先声明后使用。 */
function declarationOrderIssues(filePath: string): LintIssue[] {
  const source = readFileSync(filePath, 'utf-8')
  const clean = source
    .replace(/\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (text) => ' '.repeat(text.length))
  const issues: LintIssue[] = []
  const seen = new Set<string>()
  for (const moduleMatch of clean.matchAll(/\bmodule\b[\s\S]*?\bendmodule\b/g)) {
    const moduleText = moduleMatch[0]
    const headerEnd = moduleText.indexOf(');')
    if (headerEnd < 0) continue
    const body = moduleText.slice(headerEnd + 2)
    const bodyOffset = (moduleMatch.index ?? 0) + headerEnd + 2
    const declarations = body.matchAll(/^[ \t]*(?:wire|reg|integer|genvar)\b([^;]*);/gm)
    for (const declaration of declarations) {
      const declarationStart = declaration.index ?? 0
      // 初始化表达式中可能包含函数参数逗号；只在第一个 '=' 之前拆声明符，
      // 避免把表达式尾部误识别为另一个声明名称。
      const names = declaration[1].split('=', 1)[0]
        .replace(/\[[^\]]*\]/g, ' ')
        .split(',')
        .map((item) => item.trim().match(/[A-Za-z_$][\w$]*$/)?.[0])
        .filter((name): name is string => Boolean(name))
      for (const name of names) {
        const before = body.slice(0, declarationStart)
        // 1'b0 等数值字面量中的 b0 不是标识符。
        const use = new RegExp(`(?<!['\\w$])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`).exec(before)
        if (!use) continue
        const absolute = bodyOffset + use.index
        const line = source.slice(0, absolute).split(/\r?\n/).length
        const lineStart = source.lastIndexOf('\n', absolute - 1) + 1
        const key = `${name}:${absolute}`
        if (seen.has(key)) continue
        seen.add(key)
        issues.push({
          file: filePath,
          line,
          column: absolute - lineStart + 1,
          severity: 'error',
          rule: 'moonglass-declaration-before-use',
          message: `${name} 在声明之前已被使用；Verilog-2001 内部 wire/reg/integer/genvar 必须在首次使用前声明`
        })
      }
    }
  }
  return issues
}

/**
 * MoonGlass Verilog-2001 规则：时钟/复位信号不得参与组合逻辑（moonglass-no-clk-rst-in-comb）。
 *
 * 候选信号 = 模块内符合时钟/复位命名词干（clk/clock/rst/reset，可带 _n/n 低有效后缀与
 * i_/o_ 端口前缀，整标识符匹配）的信号 + 时序 always 敏感表中的全部信号（覆盖 clk_50m、
 * aclk 等非约定命名）。违规位置 = assign 右值（纯单信号直通转发豁免）与组合 always
 * （@* / 无沿敏感表）块体。时序 always 块整体豁免：敏感表与块内 if(!rst_n) 复位判断
 * 均属合法用法。注释与字符串字面量先行剔除，词边界保证 clkdiv、rst_cnt 等不误伤。
 */
export function clkRstInCombIssues(filePath: string): LintIssue[] {
  const source = readFileSync(filePath, 'utf-8')
  // 剔除注释与字符串字面量，避免注释或 $display("clk") 中的信号名误报
  const clean = source
    .replace(/\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (text) => ' '.repeat(text.length))
    .replace(/"[^"\n]*"/g, (text) => ' '.repeat(text.length))
  const issues: LintIssue[] = []
  // 命名词干整标识符匹配：尾随词边界使 clkdiv、rst_cnt、o_rst_status 等合法信号不匹配
  const NAME_STEM = /^(?:i_|o_)?(?:clk|clock|rst|reset)(?:_n|n)?$/i
  const IDENT = /(?<!['\w$])([A-Za-z_$][\w$]*)(?!['\w$])/g
  const SENS_KEYWORDS = new Set(['posedge', 'negedge', 'or', 'and'])
  for (const moduleMatch of clean.matchAll(/\bmodule\b[\s\S]*?\bendmodule\b/g)) {
    const moduleText = moduleMatch[0]
    const moduleOffset = moduleMatch.index ?? 0
    const candidates = new Set<string>()
    const combBlocks: Array<{ start: number; end: number }> = []
    // 第一遍：遍历 always 块。时序块（敏感表含 posedge/negedge）的敏感表信号计入候选，
    // 块体整体豁免；组合块记录块体范围供第二遍扫描。
    for (const alwaysMatch of moduleText.matchAll(/\balways\b\s*@\s*(?:\(([^)]*)\)|(\*))/g)) {
      const sens = alwaysMatch[1]
      const headerEnd = (alwaysMatch.index ?? 0) + alwaysMatch[0].length
      if (sens !== undefined && /\b(?:posedge|negedge)\b/.test(sens)) {
        for (const ident of sens.matchAll(/[A-Za-z_$][\w$]*/g)) {
          if (!SENS_KEYWORDS.has(ident[0])) candidates.add(ident[0])
        }
        continue
      }
      // 组合块体范围：begin...end 按关键字配对计数；单语句块取到语句结束分号
      let bodyEnd = moduleText.length
      const beginMatch = /^\s*begin\b/.exec(moduleText.slice(headerEnd))
      if (beginMatch) {
        let depth = 0
        for (const token of moduleText.matchAll(/\bbegin\b|\bend\b/g)) {
          if ((token.index ?? 0) < headerEnd) continue
          if (token[0] === 'begin') depth += 1
          else {
            depth -= 1
            if (depth === 0) { bodyEnd = (token.index ?? 0) + token[0].length; break }
          }
        }
      } else {
        const semi = moduleText.indexOf(';', headerEnd)
        bodyEnd = semi < 0 ? moduleText.length : semi + 1
      }
      combBlocks.push({ start: headerEnd, end: bodyEnd })
    }
    // 命名词干候选：端口声明、内部信号等全模块标识符中按约定命名匹配
    for (const ident of moduleText.matchAll(IDENT)) {
      if (NAME_STEM.test(ident[1])) candidates.add(ident[1])
    }
    if (candidates.size === 0) continue
    const candidateRe = new RegExp(
      `(?<!['\\w$])(${[...candidates].map((name) => name.replace(/[$]/g, '\\$&')).join('|')})(?!['\\w$])`,
      'g'
    )
    const makeIssue = (absolute: number, name: string): LintIssue => {
      const line = source.slice(0, absolute).split(/\r?\n/).length
      const lineStart = source.lastIndexOf('\n', absolute - 1) + 1
      return {
        file: filePath,
        line,
        column: absolute - lineStart + 1,
        severity: 'error',
        rule: 'moonglass-no-clk-rst-in-comb',
        message: `${name} 是时钟/复位信号，不得参与组合逻辑（assign 右值或 always @(*) 块体）；仅允许出现在时序 always 敏感表与复位条件中，跨时钟域须经同步器`
      }
    }
    // assign 右值扫描：纯单信号直通转发（assign o_clk = clk;）豁免，其余命中即违规
    for (const assignMatch of moduleText.matchAll(/\bassign\b\s+([^;=]+?)\s*=\s*([^;]+);/g)) {
      const rhs = assignMatch[2]
      if (/^\s*[A-Za-z_$][\w$]*\s*$/.test(rhs)) continue
      const rhsStart = (assignMatch.index ?? 0) + assignMatch[0].indexOf(rhs)
      candidateRe.lastIndex = 0
      const hit = candidateRe.exec(rhs)
      if (hit) issues.push(makeIssue(moduleOffset + rhsStart + (hit.index ?? 0), hit[1]))
    }
    // 组合块体扫描：if/三元条件、右值等任何出现均违规
    for (const block of combBlocks) {
      const body = moduleText.slice(block.start, block.end)
      for (const hit of body.matchAll(candidateRe)) {
        issues.push(makeIssue(moduleOffset + block.start + (hit.index ?? 0), hit[1]))
      }
    }
  }
  return issues
}

/** 剔除块/行注释与字符串字面量（空格替换保行号），供自研规则共用。 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (text) => ' '.repeat(text.length))
    .replace(/"[^"\n]*"/g, (text) => ' '.repeat(text.length))
}

/** always 块分类信息：kind 区分时序（敏感表含沿）与组合，body 为块体范围（相对模块文本）。 */
interface AlwaysBlockInfo {
  kind: 'seq' | 'comb'
  bodyStart: number
  bodyEnd: number
}

/** 拆分模块内的 always 块并定位块体范围（begin/end 按关键字配对计数；单语句块取到分号）。 */
function collectAlwaysBlocks(moduleText: string): AlwaysBlockInfo[] {
  const blocks: AlwaysBlockInfo[] = []
  for (const alwaysMatch of moduleText.matchAll(/\balways\b\s*@\s*(?:\(([^)]*)\)|(\*))/g)) {
    const sens = alwaysMatch[1]
    const headerEnd = (alwaysMatch.index ?? 0) + alwaysMatch[0].length
    const kind: 'seq' | 'comb' = sens !== undefined && /\b(?:posedge|negedge)\b/.test(sens) ? 'seq' : 'comb'
    let bodyEnd = moduleText.length
    const beginMatch = /^\s*begin\b/.exec(moduleText.slice(headerEnd))
    if (beginMatch) {
      let depth = 0
      for (const token of moduleText.matchAll(/\bbegin\b|\bend\b/g)) {
        if ((token.index ?? 0) < headerEnd) continue
        if (token[0] === 'begin') depth += 1
        else {
          depth -= 1
          if (depth === 0) { bodyEnd = (token.index ?? 0) + token[0].length; break }
        }
      }
    } else {
      const semi = moduleText.indexOf(';', headerEnd)
      bodyEnd = semi < 0 ? moduleText.length : semi + 1
    }
    blocks.push({ kind, bodyStart: headerEnd, bodyEnd })
  }
  return blocks
}

/** 定位文本中 for (...) 头部的跨度（含括号），供赋值类规则豁免循环变量赋值。 */
function forHeaderSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const match of text.matchAll(/\bfor\s*\(/g)) {
    let depth = 1
    let end = (match.index ?? 0) + match[0].length
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth += 1
      else if (text[end] === ')') depth -= 1
      end += 1
    }
    spans.push([match.index ?? 0, end])
  }
  return spans
}

function inSpans(spans: Array<[number, number]>, index: number): boolean {
  return spans.some(([start, end]) => index >= start && index < end)
}

/** 剥离开头的 if(...)/else/begin/end 前缀，定位真正的语句 LHS；返回剥离后的文本与消耗长度。 */
function stripLeadingControls(text: string): { rest: string; consumed: number } {
  let rest = text
  for (;;) {
    const next = /^(?:\bif\s*\([^)]*\)\s*|\belse\b\s*|\bbegin\b\s*|\bend\b\s*)/.exec(rest)
    if (!next) break
    rest = rest.slice(next[0].length)
  }
  return { rest, consumed: text.length - rest.length }
}

/** 由 clean 文本中的绝对偏移定位原始源码行列，构造 LintIssue。 */
function makeLintIssue(filePath: string, source: string, absolute: number, rule: string, message: string, severity: 'error' | 'warning' = 'error'): LintIssue {
  const line = source.slice(0, absolute).split(/\r?\n/).length
  const lineStart = source.lastIndexOf('\n', absolute - 1) + 1
  return { file: filePath, line, column: absolute - lineStart + 1, severity, rule, message }
}

/**
 * MoonGlass Verilog-2001 规则：组合 always 块内禁止非阻塞赋值（moonglass-comb-nonblocking）。
 * 语句级拆分（分号）并剥离开头的 if(...)/else/begin/end 前缀后，语句以「LHS（标识符+位选）<=」
 * 开头即命中；if (a <= b) 比较的 <= 位于已剥离的条件内、for 循环头（i <= N）位于 for 跨度内，
 * 均不命中 LHS 模式。case 分支项（4'b0: y <= a）不做检测（语句不以 LHS 开头，属已知取舍）。
 */
export function combNonblockingIssues(filePath: string): LintIssue[] {
  const source = readFileSync(filePath, 'utf-8')
  const clean = stripCommentsAndStrings(source)
  const issues: LintIssue[] = []
  for (const moduleMatch of clean.matchAll(/\bmodule\b[\s\S]*?\bendmodule\b/g)) {
    const moduleText = moduleMatch[0]
    const moduleOffset = moduleMatch.index ?? 0
    for (const block of collectAlwaysBlocks(moduleText)) {
      if (block.kind !== 'comb') continue
      const body = moduleText.slice(block.bodyStart, block.bodyEnd)
      const spans = forHeaderSpans(body)
      let segStart = 0
      for (const part of body.split(';')) {
        const trimmed = part.trimStart()
        const leading = part.length - trimmed.length
        const { rest, consumed } = stripLeadingControls(trimmed)
        const lhs = /^([A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])*)\s*<=/.exec(rest)
        if (lhs && !inSpans(spans, segStart + leading)) {
          const absolute = moduleOffset + block.bodyStart + segStart + leading + consumed
          issues.push(makeLintIssue(filePath, source, absolute, 'moonglass-comb-nonblocking',
            `组合 always 块内禁止非阻塞赋值（${lhs[1].replace(/\s+/g, '')} <=），组合逻辑一律使用阻塞赋值 =`))
        }
        segStart += part.length + 1
      }
    }
  }
  return issues
}

/**
 * MoonGlass Verilog-2001 规则：时序 always 块内对模块级寄存器的阻塞赋值（moonglass-seq-nonblocking）。
 * 依据 lowRISC 风格规则（sequential logic must use non-blocking）：阻塞赋值引入仿真/综合竞争。
 * 语句级拆分并剥离开头 if(...)/else/begin/end 前缀后，单 =（lookaround 剔除 <=、==、!=、>=、=>）
 * 且语句前缀为模块级寄存器 LHS 即命中；for 循环头位于 for 跨度内豁免，integer 变量不计入
 * 模块级寄存器；function/task 定义不在 always 块内，天然不受影响。
 */
export function seqBlockingAssignIssues(filePath: string): LintIssue[] {
  const source = readFileSync(filePath, 'utf-8')
  const clean = stripCommentsAndStrings(source)
  const issues: LintIssue[] = []
  for (const moduleMatch of clean.matchAll(/\bmodule\b[\s\S]*?\bendmodule\b/g)) {
    const moduleText = moduleMatch[0]
    const moduleOffset = moduleMatch.index ?? 0
    // 模块级时序目标：output reg 端口 + 模块体 reg 声明（integer/genvar 不计入）
    const moduleRegs = new Set<string>()
    for (const port of moduleText.matchAll(/\boutput\s+reg\b\s*(?:\[[^\]]*\]\s*)?([A-Za-z_$][\w$]*)/g)) {
      moduleRegs.add(port[1])
    }
    for (const decl of moduleText.matchAll(/^[ \t]*reg\b([^;]*);/gm)) {
      for (const raw of decl[1].split('=', 1)[0].replace(/\[[^\]]*\]/g, ' ').split(',')) {
        const name = raw.trim().match(/[A-Za-z_$][\w$]*$/)?.[0]
        if (name) moduleRegs.add(name)
      }
    }
    if (moduleRegs.size === 0) continue
    for (const block of collectAlwaysBlocks(moduleText)) {
      if (block.kind !== 'seq') continue
      const body = moduleText.slice(block.bodyStart, block.bodyEnd)
      const spans = forHeaderSpans(body)
      let segStart = 0
      for (const part of body.split(';')) {
        const trimmed = part.trimStart()
        const leading = part.length - trimmed.length
        const { rest, consumed } = stripLeadingControls(trimmed)
        const eq = /(?<![=<>!])=(?![=>])/.exec(rest)
        if (eq && !inSpans(spans, segStart + leading)) {
          // 剥离后的语句前缀必须是「LHS（标识符+位选）」紧跟该 =，才构成阻塞赋值
          const prefix = rest.slice(0, eq.index)
          const lhs = /^\s*([A-Za-z_$][\w$]*)(?:\s*\[[^\]]*\])*\s*$/.exec(prefix)
          if (lhs && moduleRegs.has(lhs[1])) {
            const absolute = moduleOffset + block.bodyStart + segStart + leading + consumed + eq.index
            issues.push(makeLintIssue(filePath, source, absolute, 'moonglass-seq-nonblocking',
              `时序 always 块内对寄存器 ${lhs[1]} 使用阻塞赋值 =，时序逻辑一律使用非阻塞赋值 <=`))
          }
        }
        segStart += part.length + 1
      }
    }
  }
  return issues
}

/**
 * MoonGlass Verilog-2001 规则：可综合 RTL 禁用 case equality（moonglass-no-case-equality）。
 * ===/!== 引入 X 语义，仿真与综合行为不一致。initial 块与 task 体属仿真-only 语境
 * （testbench 的 X 严格校验等合法用法），整体屏蔽不参与检测；function 可综合，不屏蔽。
 */
export function caseEqualityIssues(filePath: string): LintIssue[] {
  const source = readFileSync(filePath, 'utf-8')
  const clean = maskNonSynthesizableBlocks(stripCommentsAndStrings(source))
  const issues: LintIssue[] = []
  for (const match of clean.matchAll(/!==|===/g)) {
    issues.push(makeLintIssue(filePath, source, match.index ?? 0, 'moonglass-no-case-equality',
      `可综合 RTL 禁用 case equality（${match[0]}）：X 语义导致仿真与综合行为不一致，请改用 ${match[0] === '===' ? '==' : '!='}`))
  }
  return issues
}

/** 屏蔽 initial 块（begin/end 配对或单语句到分号）与 task 体（到 endtask），空格替换保行号。 */
function maskNonSynthesizableBlocks(text: string): string {
  const chars = text.split('')
  const blank = (start: number, end: number): void => {
    for (let i = start; i < end; i += 1) { if (chars[i] !== '\n') chars[i] = ' ' }
  }
  for (const match of text.matchAll(/\binitial\b/g)) {
    const start = match.index ?? 0
    let end = text.length
    const beginMatch = /^\s*begin\b/.exec(text.slice(start + match[0].length))
    if (beginMatch) {
      let depth = 0
      for (const token of text.matchAll(/\bbegin\b|\bend\b/g)) {
        if ((token.index ?? 0) < start) continue
        if (token[0] === 'begin') depth += 1
        else {
          depth -= 1
          if (depth === 0) { end = (token.index ?? 0) + token[0].length; break }
        }
      }
    } else {
      const semi = text.indexOf(';', start + match[0].length)
      end = semi < 0 ? text.length : semi + 1
    }
    blank(start, end)
  }
  for (const match of text.matchAll(/\btask\b/g)) {
    const start = match.index ?? 0
    const endToken = text.indexOf('endtask', start)
    blank(start, endToken < 0 ? text.length : endToken + 'endtask'.length)
  }
  return chars.join('')
}

/**
 * MoonGlass 规则：自赋值提醒（moonglass-self-assign，warning 级不阻塞）。
 * `X = X` / `X <= X` 多为 copy-paste 缺陷；语句带 else/if 前缀的保持态写法（else q <= q;）
 * 因 segment 不以 LHS 开头而自然豁免，故整体只做提醒不阻断门禁。
 */
export function selfAssignIssues(filePath: string): LintIssue[] {
  const source = readFileSync(filePath, 'utf-8')
  const clean = stripCommentsAndStrings(source)
  const issues: LintIssue[] = []
  for (const moduleMatch of clean.matchAll(/\bmodule\b[\s\S]*?\bendmodule\b/g)) {
    const moduleText = moduleMatch[0]
    const moduleOffset = moduleMatch.index ?? 0
    for (const stmt of moduleText.matchAll(/(?:^|[;{}]|\bbegin\b|\bend\b)\s*([A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])*)\s*(<=|=)\s*([^;{}]+?)\s*(?=;)/gm)) {
      const lhs = stmt[1].replace(/\s+/g, '')
      const rhs = stmt[3].replace(/\s+/g, '')
      if (lhs !== rhs) continue
      const absolute = moduleOffset + (stmt.index ?? 0) + stmt[0].indexOf(stmt[1])
      issues.push(makeLintIssue(filePath, source, absolute, 'moonglass-self-assign',
        `自赋值 ${lhs} ${stmt[2]} ${lhs}：若为 copy-paste 缺陷请修正；保持态（hold）写法可忽略本提醒`, 'warning'))
    }
  }
  return issues
}

/** 全部 moonglass-* 自研规则的汇总入口：error 级与 warning 级分列，供两个 lint 执行器统一挂接。 */
function moonglassCustomIssues(filePath: string): { errors: LintIssue[]; warnings: LintIssue[] } {
  return {
    errors: [
      ...declarationOrderIssues(filePath),
      ...clkRstInCombIssues(filePath),
      ...combNonblockingIssues(filePath),
      ...seqBlockingAssignIssues(filePath),
      ...caseEqualityIssues(filePath)
    ],
    warnings: [...selfAssignIssues(filePath)]
  }
}

/** 调用 verible-verilog-lint（未安装时抛错，调用方应改用 runLint 门面） */
export async function runVeribleLint(options: VeribleLintOptions): Promise<LintResult> {
  const veriblePath = await locateTool(VERIBLE_CANDIDATES)
  if (!veriblePath) throw new Error('工具未找到: verible-verilog-lint')

  const args: string[] = []
  if (options.rulesFile) args.push(`--rules_config=${options.rulesFile}`)
  if (options.autofix) args.push('--autofix')
  args.push(options.filePath)

  const { stdout, stderr } = await run(veriblePath, args, toolEnv(veriblePath))
  const issues = parseVerible(stdout + '\n' + stderr)
  return {
    passed: issues.length === 0,
    engine: 'verible',
    errors: issues,
    warnings: []
  }
}

/** verilator --lint-only 回退实现 */
async function runVerilatorLint(options: VeribleLintOptions): Promise<LintResult> {
  const { stdout, stderr } = await runWithFallback(VERILATOR_CANDIDATES, [
    '--lint-only',
    '-Wall',
    '-Wno-fatal',
    options.filePath
  ])
  const parsed = parseVerilator(stdout + '\n' + stderr)
  escalateVerilatorWarnings(parsed)
  return {
    passed: parsed.errors.length === 0,
    engine: 'verilator',
    errors: parsed.errors,
    warnings: parsed.warnings
  }
}

/** Lint 门面：verible 优先，未安装自动回退 verilator */
export async function runLint(options: VeribleLintOptions): Promise<LintResult> {
  const result = await (await hasVerible() ? runVeribleLint(options) : runVerilatorLint(options))
  const custom = moonglassCustomIssues(options.filePath)
  return {
    ...result,
    passed: result.passed && custom.errors.length === 0,
    errors: [...result.errors, ...custom.errors],
    warnings: [...result.warnings, ...custom.warnings]
  }
}

/**
 * 全设计联合 Lint。逐文件 Lint 不能建立模块层次，也不能发现跨文件端口、缺失模块和
 * 顶层 elaboration 错误；这里强制 Verilator 一次读取完整 filelist 并指定顶层。
 */
export async function runDesignLint(options: DesignLintOptions): Promise<LintResult> {
  if (options.files.length === 0) throw new Error('全设计 Lint 至少需要一个 RTL 文件')
  const args = [
    '--lint-only',
    '-Wall',
    '-Wno-fatal',
    ...(options.topModule ? ['--top-module', options.topModule] : []),
    ...(options.includeDirs ?? []).map((dir) => `-I${dir}`),
    ...(options.defines ?? []).map((define) => `-D${define}`),
    ...options.files,
    ...(options.libraryFiles ?? [])
  ]
  const verilatorPath = await locateTool(VERILATOR_CANDIDATES)
  if (!verilatorPath) throw new Error('工具未找到: verilator')
  const { stdout, stderr, code } = await run(verilatorPath, args, toolEnv(verilatorPath))
  const parsed = parseVerilator(stdout + '\n' + stderr)
  escalateVerilatorWarnings(parsed)
  const custom = options.files.map(moonglassCustomIssues)
  parsed.errors.push(...custom.flatMap((item) => item.errors))
  parsed.warnings.push(...custom.flatMap((item) => item.warnings))
  if (code !== 0 && parsed.errors.length === 0) {
    parsed.errors.push({
      line: 0,
      column: 0,
      severity: 'error',
      rule: 'ELABORATION',
      message: (stderr || stdout).trim().slice(0, 2000) || `Verilator 异常退出 (code=${code})`
    })
  }
  return { passed: parsed.errors.length === 0 && code === 0, engine: 'verilator', ...parsed }
}
