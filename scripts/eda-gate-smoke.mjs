/**
 * Phase 3 门禁检查冒烟脚本（不依赖 Electron / LLM）
 *
 * 构造临时工作区（好/坏/空三种 RTL 场景），验证：
 *   1. runLint 引擎回退与错误解析（verible 优先，verilator 兜底）
 *   2. checkSynthesizability 的 yosys 报告解析
 *   3. PhaseEngine.runGateChecks 的阻断语义
 * 运行：node scripts/eda-gate-smoke.mjs
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { runLint } = await import('../packages/eda-bridge/src/lint.ts')
const { checkSynthesizability } = await import('../packages/eda-bridge/src/synthesis.ts')
const { PhaseEngine } = await import('../src/main/services/PhaseEngine.ts')

const GOOD_V = `module counter (
  input  wire       i_clk,
  input  wire       i_rst_n,
  output reg  [7:0] o_count
);
  always @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) o_count <= 8'd0;
    else          o_count <= o_count + 8'd1;
  end
endmodule
`

const BAD_V = `module broken (
  input wire i_clk
);
  always @(posedge i_clk) begin
    // 语法错误：缺少 end / endmodule
`

const root = mkdtempSync(join(tmpdir(), 'moonglass-gate-smoke-'))
const goodDir = join(root, 'good')
const badDir = join(root, 'bad')
const emptyDir = join(root, 'empty')
const resolvedTbdDir = join(root, 'resolved-tbd')
mkdirSync(goodDir); mkdirSync(badDir); mkdirSync(emptyDir); mkdirSync(resolvedTbdDir)
writeFileSync(join(goodDir, 'counter.v'), GOOD_V)
writeFileSync(join(badDir, 'broken.v'), BAD_V)
mkdirSync(join(goodDir, 'rtl'), { recursive: true })
mkdirSync(join(goodDir, 'verification', 'counter_tb', 'rtl'), { recursive: true })
writeFileSync(join(goodDir, 'rtl', 'counter.v'), GOOD_V)
writeFileSync(join(goodDir, 'verification', 'counter_tb', 'rtl', 'counter.v'), GOOD_V)
mkdirSync(join(goodDir, 'docs', '03_design'), { recursive: true })
writeFileSync(
  join(goodDir, 'docs', '03_design', 'interface_spec.md'),
  '# Counter Interface\n\nThe counter uses i_clk and active-low i_rst_n. It exposes the eight-bit o_count output, which increments on every rising clock edge after reset release.'
)
mkdirSync(join(resolvedTbdDir, 'docs', '03_design'), { recursive: true })
writeFileSync(join(resolvedTbdDir, 'docs', '03_design', 'architecture.md'), `# Architecture

The design contains a control block and a datapath block connected through a registered command interface.

\`\`\`mermaid
flowchart LR
  Control --> Datapath
\`\`\`

## 待确定问题

| TBD ID | 描述 | 状态 |
|---|---|---|
| TBD-001 | ✅ 参数已经确定 | 已关闭 |
`)
writeFileSync(join(resolvedTbdDir, 'docs', '03_design', 'clock_reset.md'), `# Clock and Reset

The design uses a single core clock. Reset is asserted asynchronously and released synchronously through a two-stage synchronizer. All state elements return to documented reset values.
`)
writeFileSync(join(resolvedTbdDir, 'docs', '03_design', 'interface_spec.md'), `# Interface Specification

The control block accepts a registered command interface and returns a valid response from the datapath. Signal direction, width, clock domain, and reset behavior are defined for every top-level port.
`)
writeFileSync(join(resolvedTbdDir, 'docs', '03_design', 'microarchitecture.md'), `# Microarchitecture

The registered control block decodes commands and schedules datapath operations. The datapath captures operands, performs the selected operation, and registers the result before asserting response valid.
`)

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// ---------- 1. runLint ----------
const lintGood = await runLint({ filePath: join(goodDir, 'counter.v') })
check('lint 好文件通过', lintGood.passed, `engine=${lintGood.engine} errors=${lintGood.errors.length} warnings=${lintGood.warnings.length}`)

const lintBad = await runLint({ filePath: join(badDir, 'broken.v') })
check('lint 坏文件报错', !lintBad.passed && lintBad.errors.length > 0, `engine=${lintBad.engine} errors=${lintBad.errors.length}`)
if (lintBad.errors[0]) console.log('  示例错误:', JSON.stringify(lintBad.errors[0]))

// ---------- 2. checkSynthesizability ----------
const synthGood = await checkSynthesizability({ rtlFiles: [join(goodDir, 'counter.v')] })
check('yosys 好文件可综合', synthGood.synthesizable, `cells=${synthGood.resourceEstimate.cells} wires=${synthGood.resourceEstimate.wires}`)

const synthBad = await checkSynthesizability({ rtlFiles: [join(badDir, 'broken.v')] })
check('yosys 坏文件不可综合', !synthBad.synthesizable)
if (synthBad.issues[0]) console.log('  示例问题:', synthBad.issues[0].message.slice(0, 120))

// ---------- 3. PhaseEngine 门禁语义 ----------
const engine = new PhaseEngine()
const fakeProject = (phase) => ({ currentPhase: phase })

const rtlToVerif = async (dir) =>
  engine.runGateChecks(fakeProject('RTL'), 'VERIF', { workspaceDir: dir })

const passResults = await rtlToVerif(goodDir)
const lintCheck = passResults.find((r) => r.checkId === 'verible-lint-zero-error')
check('RTL→VERIF 好文件门禁通过', lintCheck?.passed === true, lintCheck?.message)
check('RTL→VERIF 好文件不阻断', !engine.isBlocked(passResults))
check(
  '验证环境 DUT 镜像不参与设计门禁',
  lintCheck?.message.includes('1 个文件') === true,
  lintCheck?.message
)

const failResults = await rtlToVerif(badDir)
const lintFail = failResults.find((r) => r.checkId === 'verible-lint-zero-error')
check('RTL→VERIF 坏文件门禁失败', lintFail?.passed === false, lintFail?.message)
check('RTL→VERIF 坏文件阻断', engine.isBlocked(failResults))
const portCheck = failResults.find((r) => r.checkId === 'port-consistency')
check('端口文档门禁真实阻断', portCheck?.passed === false && portCheck?.severity === 'error', portCheck?.message)

const emptyResults = await rtlToVerif(emptyDir)
check('空工作区门禁失败（无 RTL）', engine.isBlocked(emptyResults), emptyResults.find((r) => r.checkId === 'verible-lint-zero-error')?.message)

const qaResults = await engine.runGateChecks(fakeProject('QA'), 'SYNTH', { workspaceDir: badDir })
const yosysCheck = qaResults.find((r) => r.checkId === 'yosys-synthesizable')
check('QA→SYNTH 坏文件 yosys 阻断', yosysCheck?.passed === false && engine.isBlocked(qaResults), yosysCheck?.message)

const reqResults = await engine.runGateChecks(fakeProject('REQ'), 'SPEC', { workspaceDir: emptyDir })
check(
  'REQ 文档遗留项为警告且允许推进',
  reqResults.every((result) => !result.passed && result.severity === 'warning') && !engine.isBlocked(reqResults)
)

const resolvedTbdResults = await engine.runGateChecks(
  fakeProject('ARCH'),
  'RTL',
  { workspaceDir: resolvedTbdDir }
)

const fastTrackProject = {
  ...fakeProject('RTL'),
  phases: {
    REQ: {}, SPEC: {}, ARCH: {},
    RTL: { status: 'active', gateCheckResults: [] },
    VERIF: { status: 'locked', gateCheckResults: [] },
    QA: { status: 'locked', gateCheckResults: [] },
    SYNTH: { status: 'locked', gateCheckResults: [] }
  }
}
engine.fastTrackSynthesis(fastTrackProject)
check(
  'RTL 可跳过 VERIF/QA 进入快速综合',
  fastTrackProject.currentPhase === 'SYNTH' &&
    fastTrackProject.phases.VERIF.status === 'skipped' &&
    fastTrackProject.phases.QA.status === 'skipped' &&
    fastTrackProject.phases.SYNTH.status === 'active'
)
engine.completeProject(fastTrackProject)
check(
  'SYNTH 完成后项目进入最终完成状态',
  fastTrackProject.phases.SYNTH.status === 'completed' &&
    fastTrackProject.phases.SYNTH.completedAt !== undefined
)
check(
  '已关闭的 TBD 追踪表不触发误报',
  resolvedTbdResults.every((result) => result.passed) && !engine.isBlocked(resolvedTbdResults),
  resolvedTbdResults.find((result) => !result.passed)?.message
)

console.log('')
console.log(failures === 0 ? '✅ 门禁冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
