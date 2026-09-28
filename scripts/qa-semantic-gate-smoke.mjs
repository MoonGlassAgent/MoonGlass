// QA 语义门禁冒烟（v0.9.8 契约）：验证 QA→SYNTH 新增的四个门禁检查
// qa-spec-implementation-reviewed / qa-verification-completeness / qa-code-review-done / qa-reset-review-documented
// 的阻断与放行路径；顺带断言 auditVerificationCompleteness 引擎函数的闭集口径。
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { buildVerificationIntelligence, registerVerificationIntents, computeRtlHash, auditVerificationCompleteness } = await import('../packages/verification-intelligence-engine/src/index.ts')
const { PhaseEngine } = await import('../src/main/services/PhaseEngine.ts')

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const root = mkdtempSync(join(tmpdir(), 'moonglass-qa-semantic-gate-'))
mkdirSync(join(root, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(root, 'rtl'), { recursive: true })
mkdirSync(join(root, 'rtlqa'), { recursive: true })
mkdirSync(join(root, 'verification', 'results', 'simple'), { recursive: true })

writeFileSync(join(root, 'docs', '02_requirements', 'product_requirements.md'), `
# 计数器需求

- REQ-CNT-001 P0: 计数器必须在使能时按周期递增，复位时清零。
- SPEC-CNT-001 P1: 计数达到最大值后必须自然回绕到零，溢出不得造成状态丢失。
`, 'utf-8')

writeFileSync(join(root, 'rtl', 'simple.v'), `module simple(input clk, input rst_n, input en, output reg [2:0] count);
always @(posedge clk or negedge rst_n) begin
  if (!rst_n) count <= 0;
  else if (en) count <= count + 1'b1;
  else count <= count;
end
endmodule
`, 'utf-8')
writeFileSync(join(root, 'rtl', 'design.json'), JSON.stringify({ topModule: 'simple' }, null, 2), 'utf-8')
writeFileSync(join(root, 'verification', 'results', 'simple', 'result.json'), JSON.stringify({ passed: true, testsTotal: 4, coverage: { lineCoverage: 95 } }, null, 2), 'utf-8')

const engine = new PhaseEngine()
const fakeProject = (phase) => ({ currentPhase: phase })
const qaChecks = async () => {
  const results = await engine.runGateChecks(fakeProject('QA'), 'SYNTH', { workspaceDir: root })
  const byId = new Map(results.map((r) => [r.checkId, r]))
  return byId
}

// ---------- 负向：四项语义门禁均未就绪 ----------
let byId = await qaChecks()
check('无审查文件时 qa-spec-implementation-reviewed 阻断', byId.get('qa-spec-implementation-reviewed')?.passed === false, byId.get('qa-spec-implementation-reviewed')?.message)
check('无裁决清单时 qa-code-review-done 阻断', byId.get('qa-code-review-done')?.passed === false)
check('无复位评审文档时 qa-reset-review-documented 阻断', byId.get('qa-reset-review-documented')?.passed === false)
check('无验证点时 qa-verification-completeness 阻断', byId.get('qa-verification-completeness')?.passed === false, byId.get('qa-verification-completeness')?.message)
const audit = auditVerificationCompleteness(root)
// CLAUSE_DERIVED 派生候选使条款进入 MAPPED_UNTESTED（有占位意图/场景），审计应阻断在"缺当前 RTL 版本 PASS 证据"
check('引擎审计：条款无 PASS 证据时逐条阻断', audit.passed === false && audit.blockers.length === 2 && audit.blockers.every((b) => b.includes('MAPPED_UNTESTED') || b.includes('无验证点')), audit.blockers.join(' | '))

// ---------- 正向：登记验证点 + PASS 证据 + 三类审查产物 ----------
const model = buildVerificationIntelligence(root)
const clauseIds = model.requirementModel.requirements
  .filter((item) => (item.clauseKind ?? 'verifiable') === 'verifiable' && (item.channel ?? 'simulation') !== 'synthesis')
  .map((item) => item.id)
if (clauseIds.length !== 2) throw new Error(`fixture 条款数异常：${clauseIds.join(',')}`)

// basic 波段不得锚定 formal-candidate 类风险（R02/R05/R19），挑一个非 formal 类风险
const anchorRisk = model.risks.find((risk) => !['R02', 'R05', 'R19'].includes(risk.taxonomyId)) ?? model.risks[0]
if (!anchorRisk) throw new Error('fixture 未产生任何风险标记，无法锚定意图')
const registered = registerVerificationIntents(root, [{
  title: '计数器基础功能验证',
  objective: '验证使能递增、复位清零与回绕行为',
  failureMode: '反例：计数不递增或复位后非零',
  passCriteria: ['使能期间每周期 count+1', '复位后 count==0', '溢出后回绕到 0'],
  anchors: { riskIds: [anchorRisk.id], requirementIds: clauseIds, rtlSignals: ['simple.count', 'count'] },
  recommendedMethod: 'simulation',
  wave: 'basic'
}])
if (registered.accepted.length === 0) throw new Error(`Intent 登记被拒绝：${JSON.stringify(registered.rejected)}`)

const rtlHash = computeRtlHash(root)
writeFileSync(join(root, 'verification', 'results', 'simple', 'scenario_hits.json'), JSON.stringify({
  rtlHash,
  scenarios: registered.accepted.map((id) => ({ id, reached: true, passed: true, reachCount: 1, rtlHash, evidence: ['result.json'], generatedAt: new Date().toISOString() }))
}, null, 2), 'utf-8')

writeFileSync(join(root, 'rtlqa', 'spec-implementation-review.json'), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(), rtlHash,
  reviews: clauseIds.map((id) => ({ clauseId: id, verdict: 'implemented', evidence: ['rtl/simple.v'], note: 'counter 模块 always 块实现' }))
}, null, 2), 'utf-8')
writeFileSync(join(root, 'rtlqa', 'code-review-verdicts.json'), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(), rtlHash,
  items: Array.from({ length: 12 }, (_, i) => ({ id: `CR-${String(i + 1).padStart(2, '0')}`, status: 'pass', note: 'fixture' }))
}, null, 2), 'utf-8')
mkdirSync(join(root, 'docs', '06_validation'), { recursive: true })
writeFileSync(join(root, 'docs', '06_validation', 'reset_review.md'), `
# 复位风险评审结论

本设计采用低电平有效异步复位，释放经时序路径直接驱动寄存器，无组合门控；
单时钟域无跨复位域交叉，所有复位相关 lint 规则零违规，评审结论为可接受。
`, 'utf-8')

byId = await qaChecks()
check('全部就绪后 qa-spec-implementation-reviewed 放行', byId.get('qa-spec-implementation-reviewed')?.passed === true, byId.get('qa-spec-implementation-reviewed')?.message)
check('全部就绪后 qa-code-review-done 放行', byId.get('qa-code-review-done')?.passed === true, byId.get('qa-code-review-done')?.message)
check('全部就绪后 qa-reset-review-documented 放行', byId.get('qa-reset-review-documented')?.passed === true, byId.get('qa-reset-review-documented')?.message)
check('全部就绪后 qa-verification-completeness 放行', byId.get('qa-verification-completeness')?.passed === true, byId.get('qa-verification-completeness')?.message)

// ---------- 负向：partial 裁决无具名豁免被阻断 ----------
writeFileSync(join(root, 'rtlqa', 'spec-implementation-review.json'), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(), rtlHash,
  reviews: clauseIds.map((id, index) => index === 0
    ? { clauseId: id, verdict: 'partial', note: '部分实现' }
    : { clauseId: id, verdict: 'implemented', evidence: ['rtl/simple.v'] })
}, null, 2), 'utf-8')
byId = await qaChecks()
check('partial 裁决无豁免时阻断', byId.get('qa-spec-implementation-reviewed')?.passed === false && byId.get('qa-spec-implementation-reviewed')?.message.includes('具名豁免'), byId.get('qa-spec-implementation-reviewed')?.message)

// ---------- 具名豁免后放行 ----------
mkdirSync(join(root, 'verification', 'intelligence'), { recursive: true })
writeFileSync(join(root, 'verification', 'intelligence', 'signoff-approvals.json'), JSON.stringify({
  approvals: [{ riskId: 'SPEC-WAIVER-CNT-001', approver: 'fixture-approver', rationale: '回绕语义由规格书附录覆盖', approvedAt: new Date().toISOString() }]
}, null, 2), 'utf-8')
writeFileSync(join(root, 'rtlqa', 'spec-implementation-review.json'), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(), rtlHash,
  reviews: clauseIds.map((id, index) => index === 0
    ? { clauseId: id, verdict: 'partial', waiverId: 'SPEC-WAIVER-CNT-001', note: '部分实现，已具名豁免' }
    : { clauseId: id, verdict: 'implemented', evidence: ['rtl/simple.v'] })
}, null, 2), 'utf-8')
byId = await qaChecks()
check('partial 裁决挂具名豁免后放行', byId.get('qa-spec-implementation-reviewed')?.passed === true, byId.get('qa-spec-implementation-reviewed')?.message)

// ---------- 负向：rtlHash 过期审查不被采信 ----------
writeFileSync(join(root, 'rtlqa', 'spec-implementation-review.json'), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(), rtlHash: 'deadbeef-stale-hash',
  reviews: clauseIds.map((id) => ({ clauseId: id, verdict: 'implemented', evidence: ['rtl/simple.v'] }))
}, null, 2), 'utf-8')
byId = await qaChecks()
check('旧 rtlHash 的语义审查不被采信', byId.get('qa-spec-implementation-reviewed')?.passed === false && byId.get('qa-spec-implementation-reviewed')?.message.includes('旧 RTL 版本'), byId.get('qa-spec-implementation-reviewed')?.message)

// ---------- sim-passed 门禁新鲜度：rtlHash 缺失/不匹配的回归证据不采信 ----------
let verifResults = await engine.runGateChecks(fakeProject('VERIF'), 'QA', { workspaceDir: root })
let simPassedCheck = verifResults.find((r) => r.checkId === 'sim-passed')
check('回归证据缺 rtlHash 时 sim-passed 判过期阻断', simPassedCheck?.passed === false && simPassedCheck?.message.includes('过期'), simPassedCheck?.message)
const resultJsonPath = join(root, 'verification', 'results', 'simple', 'result.json')
writeFileSync(resultJsonPath, JSON.stringify({ ...JSON.parse(readFileSync(resultJsonPath, 'utf-8')), rtlHash: computeRtlHash(root) }, null, 2), 'utf-8')
verifResults = await engine.runGateChecks(fakeProject('VERIF'), 'QA', { workspaceDir: root })
simPassedCheck = verifResults.find((r) => r.checkId === 'sim-passed')
check('rtlHash 匹配后 sim-passed 放行', simPassedCheck?.passed === true, simPassedCheck?.message)

// ---------- 死逻辑检查门禁（qa-dead-logic-adjudicated，2026-09-28 需求） ----------
// 报告缺失：提示放行（warning），不阻断
check('死逻辑报告缺失时提示而非阻断', byId.get('qa-dead-logic-adjudicated')?.passed === true && byId.get('qa-dead-logic-adjudicated')?.severity === 'warning', byId.get('qa-dead-logic-adjudicated')?.message)
// 存在未裁决 spec-anchored 项：阻断
mkdirSync(join(root, 'rtlqa', 'lint'), { recursive: true })
writeFileSync(join(root, 'rtlqa', 'lint', 'dead_logic_report.json'), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(), tool: { name: 'slang', version: 'fixture' },
  stats: { modules: 1, signals: 2, undriven: 1, unused: 1, dead: 0, specAnchored: 1, internal: 1 },
  issues: [
    { module: 'simple', signal: 'o_dbg', kind: 'undriven', classification: 'spec-anchored', topLevelPort: true, file: 'rtl/simple.v', line: 3, suggestion: 'fixture' },
    { module: 'simple', signal: 'w_tmp', kind: 'unused', classification: 'internal', topLevelPort: false, file: 'rtl/simple.v', line: 4, suggestion: 'fixture' }
  ],
  adjudications: []
}, null, 2), 'utf-8')
byId = await qaChecks()
check('未裁决 spec-anchored 项阻断', byId.get('qa-dead-logic-adjudicated')?.passed === false && byId.get('qa-dead-logic-adjudicated')?.message.includes('simple.o_dbg'), byId.get('qa-dead-logic-adjudicated')?.message)
// 非法裁决（缺 rationale）：阻断
writeFileSync(join(root, 'rtlqa', 'lint', 'dead_logic_report.json'), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(), tool: { name: 'slang', version: 'fixture' },
  stats: { modules: 1, signals: 2, undriven: 1, unused: 1, dead: 0, specAnchored: 1, internal: 1 },
  issues: [{ module: 'simple', signal: 'o_dbg', kind: 'undriven', classification: 'spec-anchored', topLevelPort: true, file: 'rtl/simple.v', line: 3, suggestion: 'fixture' }],
  adjudications: [{ key: 'simple.o_dbg', decision: 'keep', rationale: '' }]
}, null, 2), 'utf-8')
byId = await qaChecks()
check('裁决缺 rationale 阻断', byId.get('qa-dead-logic-adjudicated')?.passed === false && byId.get('qa-dead-logic-adjudicated')?.message.includes('裁决非法'), byId.get('qa-dead-logic-adjudicated')?.message)
// 合法裁决：放行
writeFileSync(join(root, 'rtlqa', 'lint', 'dead_logic_report.json'), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(), tool: { name: 'slang', version: 'fixture' },
  stats: { modules: 1, signals: 2, undriven: 1, unused: 1, dead: 0, specAnchored: 1, internal: 1 },
  issues: [{ module: 'simple', signal: 'o_dbg', kind: 'undriven', classification: 'spec-anchored', topLevelPort: true, file: 'rtl/simple.v', line: 3, suggestion: 'fixture' }],
  adjudications: [{ key: 'simple.o_dbg', decision: 'keep', rationale: '预留调试观测口', decidedBy: 'fixture-engineer', decidedAt: new Date().toISOString() }]
}, null, 2), 'utf-8')
byId = await qaChecks()
check('spec-anchored 全部合法裁决后放行', byId.get('qa-dead-logic-adjudicated')?.passed === true, byId.get('qa-dead-logic-adjudicated')?.message)

console.log(failures === 0 ? '\n✅ QA 语义门禁冒烟全部通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
