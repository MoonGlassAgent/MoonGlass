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
const { PhaseEngine, markPhaseChanged, enterPhase, acknowledgePhaseChange } = await import('../src/main/services/PhaseEngine.ts')

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
const simpleArchDir = join(root, 'simple-arch')
mkdirSync(goodDir); mkdirSync(badDir); mkdirSync(emptyDir); mkdirSync(resolvedTbdDir); mkdirSync(simpleArchDir)
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
mkdirSync(join(simpleArchDir, 'docs', '03_design'), { recursive: true })
writeFileSync(join(simpleArchDir, 'docs', '03_design', 'architecture.md'), `# Simple Architecture

This IP is a single registered counter block with one clock and one active-low reset. The concise internal behavior and reset policy are documented here because separate microarchitecture and clock/reset documents would add no review value.

\`\`\`mermaid
flowchart LR
  Input --> Counter --> Output
\`\`\`
`)
writeFileSync(join(simpleArchDir, 'docs', '03_design', 'interface_spec.md'), `# Interface Specification

The block has one input clock, one active-low reset, one enable input, and one registered counter output. Every signal uses the same clock and reset domain, with no CDC or RDC path.
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

const reqResults = await engine.runGateChecks(fakeProject('REQ_SPEC'), 'ARCH', { workspaceDir: emptyDir })
check(
  'REQ_SPEC 文档缺失会阻断进入 ARCH',
  reqResults.some((result) => !result.passed && result.severity === 'error') && engine.isBlocked(reqResults)
)

const reqSpecDir = join(root, 'req-spec-ready')
mkdirSync(join(reqSpecDir, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(reqSpecDir, 'docs', '03_design'), { recursive: true })
writeFileSync(join(reqSpecDir, 'docs', '02_requirements', 'product_requirements.md'), '# 产品需求\n\nREQ-FUNC-001：计数器必须按时钟递增，并可通过复位清零。验收标准为连续十个周期计数结果正确。输入时钟必须稳定，复位信号有效期间输出保持为零，解除复位后的首个有效时钟沿开始计数。\n\nREQ-PERF-001、REQ-PERF-002、REQ-PERF-003：覆盖三级性能档位。\n')
writeFileSync(join(reqSpecDir, 'docs', '02_requirements', 'module_specification.md'), '# 模块规格\n\nSPEC-FUNC-001：计数器模块接收时钟与复位，输出单调递增计数值；复位后输出必须为零。关联 REQ-FUNC-001。计数宽度固定为八位，达到最大值后自然回绕，所有输出仅在有效时钟沿更新。\n')
writeFileSync(join(reqSpecDir, 'docs', '02_requirements', 'requirements_traceability.md'), '# 需求-规格追溯矩阵\n\n## 版本历史\n\n| 版本 | 日期 | 作者 | 变更 |\n|---|---|---|---|\n| 0.2 | 2026-08-20 | 设计团队 | 增加 P0/P1/P2 说明，提及 REQ-FUNC-001 |\n\n## 优先级说明\n\n| 优先级 | 含义 | 需求 |\n|---|---|---|\n| P0 | 必须实现 | REQ-FUNC-001、REQ-PERF-001~003 |\n| P1 | 应该实现 | 暂无 |\n| P2 | 可延后 | 暂无 |\n\n## 正式追溯矩阵\n\n| 需求 ID | 需求摘要 | 规格 ID | 状态 |\n|---|---|---|---|\n| REQ-FUNC-001 | 计数递增 | SPEC-FUNC-001 | 已定义 |\n| REQ-PERF-001~003 | 性能档位 | SPEC-PERF-001 | 已定义 |\n\n## 假设与 TBD\n\n| 编号 | 内容 | 关联需求 | 责任人 | 状态 |\n|---|---|---|---|---|\n| ASSUME-001 | 工艺频率未定 | REQ-PERF-002 | 架构师 | 开放 |\n')
writeFileSync(join(reqSpecDir, 'docs', '03_design', 'interface_spec.md'), '# 接口规格\n\n| 信号 | 方向 | 位宽 | 时钟域 |\n|---|---|---|---|\n| i_clk | input | 1 | clk |\n| i_rst_n | input | 1 | clk |\n| o_count | output | 8 | clk |\n')
const reqSpecResults = await engine.runGateChecks(fakeProject('REQ_SPEC'), 'ARCH', { workspaceDir: reqSpecDir })
check('REQ_SPEC 完整交付物允许进入 ARCH', reqSpecResults.every((result) => result.passed), reqSpecResults.find((result) => !result.passed)?.message)
check(
  '追溯门禁忽略版本/优先级/TBD 表并支持需求 ID 范围',
  reqSpecResults.find((result) => result.checkId === 'rtm-complete')?.passed === true,
  reqSpecResults.find((result) => result.checkId === 'rtm-complete')?.message
)

const simpleArchResults = await engine.runGateChecks(fakeProject('ARCH'), 'RTL', { workspaceDir: simpleArchDir })
check(
  '简单设计缺少独立微架构/时钟复位文档不阻断 RTL',
  !engine.isBlocked(simpleArchResults) &&
    simpleArchResults.find((result) => result.checkId === 'module-partition-sane')?.passed === true &&
    simpleArchResults.find((result) => result.checkId === 'clock-reset-defined')?.passed === true,
  simpleArchResults.find((result) => !result.passed)?.message
)

const resolvedTbdResults = await engine.runGateChecks(
  fakeProject('ARCH'),
  'RTL',
  { workspaceDir: resolvedTbdDir }
)

const fastTrackProject = {
  ...fakeProject('RTL'),
  phases: {
    REQ_SPEC: {}, ARCH: {},
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

const phaseNames = ['REQ_SPEC', 'ARCH', 'RTL', 'VERIF', 'QA', 'SYNTH']
const changeProject = {
  currentPhase: 'ARCH',
  phases: Object.fromEntries(phaseNames.map((phase) => [phase, {
    status: phase === 'REQ_SPEC' || phase === 'RTL' || phase === 'VERIF'
      ? 'completed'
      : phase === 'ARCH' ? 'active' : 'locked',
    deliverables: phase === 'RTL' ? [{ id: 'rtl-1' }] : [],
    agentContext: { messageCount: 0 },
    reviewStatus: 'approved',
    gateCheckResults: []
  }]))
}
markPhaseChanged(changeProject, 'ARCH', '接口规格新增一个握手信号')
check('阶段修改不删除后续交付物', changeProject.phases.RTL.deliverables.length === 1)
check('阶段修改只传播到已完成的后续阶段',
  changeProject.phases.RTL.changeNotice?.status === 'pending' &&
  changeProject.phases.VERIF.changeNotice?.status === 'pending' &&
  changeProject.phases.QA.changeNotice === undefined &&
  changeProject.phases.SYNTH.changeNotice === undefined)
enterPhase(changeProject, 'RTL')
check('双击进入阶段不清理其他后续结果', changeProject.currentPhase === 'RTL' && changeProject.phases.VERIF.status === 'completed')
acknowledgePhaseChange(changeProject, 'RTL', '已完成 RTL 变更响应')
check('后续阶段可单独完成变更响应', changeProject.phases.RTL.changeNotice?.status === 'responded' && changeProject.phases.VERIF.changeNotice?.status === 'pending')
check(
  '已关闭的 TBD 追踪表不触发误报',
  resolvedTbdResults.every((result) => result.passed) && !engine.isBlocked(resolvedTbdResults),
  resolvedTbdResults.find((result) => !result.passed)?.message
)

console.log('')
console.log(failures === 0 ? '✅ 门禁冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
