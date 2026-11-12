/**
 * fix-dispatch-filter 变更回归冒烟（2026-11-11，DEC-BB2FE5ED 生效验证）
 *
 * 变更二（裁决持久化优先级，engine.ts refreshScenarioWithHits + buildScenarios）：
 *   D1：BLOCKED_BY_SPEC 场景在裁决之后产生更新的 FAIL hit → rebuild 后 status 必须保持
 *       BLOCKED_BY_SPEC（证据照常透传 failureSummary），不得被回写 FAILED；
 *   D2：WAIVED 场景在裁决之后产生更新的 FAIL hit → rebuild 后 status 保持 WAIVED；
 *   D3：无判断类裁决的 FAILED 场景（FAIL hit）→ rebuild 后仍正常 FAILED（过滤不误伤）。
 *
 * 变更一（修复派单前置过滤，rtl-fix-verdict.ts judgeFixDispatchGate）：
 *   G1：BLOCKED_BY_SPEC / WAIVED 场景 → blocked=true；
 *   G2：FAILED 场景（无裁决）→ blocked=false（合法 FAILED 仍在派发候选）；
 *   G3：registry 中不存在的场景 / registry 缺失 → blocked=false（防御性放行，不误拦）。
 *
 * 运行：node scripts/fix-dispatch-filter-smoke.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVerificationIntelligence } from '../packages/verification-intelligence-engine/src/index.ts'
import { judgeFixDispatchGate } from '../src/main/services/rtl-fix-verdict.ts'

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`PASS  ${name}`)
  else { failures += 1; console.error(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`) }
}

// ==================== 变更二：裁决持久化优先级（真实 rebuild 路径） ====================

const root = mkdtempSync(join(tmpdir(), 'moonglass-fix-dispatch-filter-'))
mkdirSync(join(root, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(root, 'rtl'), { recursive: true })
mkdirSync(join(root, 'verification', 'intelligence'), { recursive: true })
mkdirSync(join(root, 'verification', 'results', 'test_mod'), { recursive: true })

writeFileSync(join(root, 'docs', '02_requirements', 'product_requirements.md'), `
# DID Requirements

- REQ-001 P0: 控制器在复位后 3 个周期内完成初始化。
`, 'utf-8')

writeFileSync(join(root, 'rtl', 'test_top.v'), `
module test_top(input i_clk, input i_rst_n, output reg [3:0] o_cnt);
  always @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) o_cnt <= 4'd0;
    else o_cnt <= o_cnt + 4'd1;
  end
endmodule
`, 'utf-8')

/** 构造上一轮 registry 场景（AGENT_INTENT，由 readPrevious 读入并经 refreshScenarioWithHits 刷新）。 */
const scenarioSeed = (id, status, adjudicatedAt) => ({
  id,
  origin: 'AGENT_INTENT',
  wave: 'basic',
  title: `测试场景 ${id}`,
  riskIds: [],
  requirementIds: ['REQ-001'],
  rtlObjects: ['test_top'],
  features: ['复位'],
  trigger: ['DUT 完成复位并处于正常工作状态'],
  expected: ['o_cnt 按规格递增'],
  method: 'simulation',
  status,
  state: { lifecycle: 'DISCOVERED', reach: 'UNKNOWN', judgment: 'UNKNOWN', evidence: 'MISSING', freshness: 'CURRENT', closure: 'OPEN' },
  coordinates: { feature: ['复位'], boundary: [], interaction: [], temporal: [], systemState: [] },
  rtlHash: 'deadbeef',
  risk: 0.5, interaction: 0.5, coverageGap: 1, criticality: 0.8, confidenceFactor: 0.85, costFactor: 0.9,
  priority: 0.2,
  reason: 'smoke seed',
  evidence: [],
  reachCount: 0,
  coverageDelta: {},
  updatedAt: '2026-11-10T00:00:00.000Z',
  ...(adjudicatedAt ? { adjudicatedAt } : {})
})

writeFileSync(join(root, 'verification', 'intelligence', 'scenario-registry.json'), JSON.stringify({
  version: 2,
  generatedAt: '2026-11-10T00:00:00.000Z',
  rtlHash: 'deadbeef',
  scenarios: [
    scenarioSeed('SCN-TEST0001', 'BLOCKED_BY_SPEC', '2026-11-10T01:00:00.000Z'),
    scenarioSeed('SCN-TEST0002', 'WAIVED', '2026-11-10T01:00:00.000Z'),
    scenarioSeed('SCN-TEST0003', 'FAILED', undefined)
  ]
}, null, 2), 'utf-8')

// FAIL hit 落盘时间（文件 mtime=observedAt）晚于两条判断类裁决的 adjudicatedAt ——
// 旧口径（裁决须晚于证据）会把这三条全部翻成 FAILED，新口径必须只翻 SCN-TEST0003。
writeFileSync(join(root, 'verification', 'results', 'test_mod', 'scenario_hits.json'), JSON.stringify({
  version: 1,
  rtlHash: 'deadbeef',
  scenarios: [
    { id: 'SCN-TEST0001', status: 'FAILED', reached: true, passed: false, channel: 'simulation', failureSummary: 'BLOCKED 场景的新 FAIL 证据', evidence: ['../../../docs/02_requirements/product_requirements.md'] },
    { id: 'SCN-TEST0002', status: 'FAILED', reached: true, passed: false, channel: 'simulation', evidence: ['../../../docs/02_requirements/product_requirements.md'] },
    { id: 'SCN-TEST0003', status: 'FAILED', reached: true, passed: false, channel: 'simulation', evidence: ['../../../docs/02_requirements/product_requirements.md'] }
  ]
}, null, 2), 'utf-8')

const result = buildVerificationIntelligence(root)
const byId = new Map(result.verificationState.scenarios.map((item) => [item.id, item]))

const blocked = byId.get('SCN-TEST0001')
check('D1 BLOCKED_BY_SPEC + 更新 FAIL hit → status 保持 BLOCKED_BY_SPEC', blocked?.status === 'BLOCKED_BY_SPEC', `实际=${blocked?.status}`)
check('D1a 失败证据照常透传（failureSummary 追加到证据链）', blocked?.failureSummary === 'BLOCKED 场景的新 FAIL 证据', `实际=${blocked?.failureSummary}`)
check('D1b 证据文件并入 evidence', (blocked?.evidence ?? []).some((path) => path.includes('product_requirements.md')), `evidence=${JSON.stringify(blocked?.evidence)}`)

const waived = byId.get('SCN-TEST0002')
check('D2 WAIVED + 更新 FAIL hit → status 保持 WAIVED', waived?.status === 'WAIVED', `实际=${waived?.status}`)

const failed = byId.get('SCN-TEST0003')
check('D3 无判断类裁决的 FAILED → rebuild 后仍 FAILED（不误伤）', failed?.status === 'FAILED', `实际=${failed?.status}`)

// registry 落盘一致性（单一事实源）
const registryScenarios = JSON.parse(readFileSync(join(root, 'verification', 'intelligence', 'scenario-registry.json'), 'utf-8')).scenarios
const registryById = new Map(registryScenarios.map((item) => [item.id, item]))
check('D4 registry 落盘 SCN-TEST0001 保持 BLOCKED_BY_SPEC', registryById.get('SCN-TEST0001')?.status === 'BLOCKED_BY_SPEC', `实际=${registryById.get('SCN-TEST0001')?.status}`)
check('D5 registry 落盘 SCN-TEST0003 正常 FAILED', registryById.get('SCN-TEST0003')?.status === 'FAILED', `实际=${registryById.get('SCN-TEST0003')?.status}`)
const statusCounts = result.verificationState.statusCounts
// 计数口径：只有 SCN-TEST0003 允许进入 FAILED；两条判断类裁决场景不得因 FAIL hit 增加 FAILED 计数，
// BLOCKED_BY_SPEC/WAIVED 计数不得少于种子（引擎可能另派生同状态候选，不影响本变更口径）。
check('D6 态势计数：FAILED=1（仅无裁决场景），BLOCKED_BY_SPEC>=1 且 WAIVED>=1',
  statusCounts.FAILED === 1 && (statusCounts.BLOCKED_BY_SPEC ?? 0) >= 1 && (statusCounts.WAIVED ?? 0) >= 1, JSON.stringify(statusCounts))

rmSync(root, { recursive: true, force: true })

// ==================== 变更一：修复派单前置过滤（纯函数） ====================

const gateRoot = mkdtempSync(join(tmpdir(), 'moonglass-fix-dispatch-gate-'))
mkdirSync(join(gateRoot, 'verification', 'intelligence'), { recursive: true })
writeFileSync(join(gateRoot, 'verification', 'intelligence', 'scenario-registry.json'), JSON.stringify({
  version: 2,
  scenarios: [
    { id: 'SCN-8A521B7D', status: 'BLOCKED_BY_SPEC' },
    { id: 'SCN-WAIVED001', status: 'WAIVED' },
    { id: 'SCN-E081F289', status: 'FAILED' },
    { id: 'SCN-FAB823EC', status: 'FAILED' },
    { id: 'SCN-6D7E1E68', status: 'FAILED' }
  ]
}, null, 2), 'utf-8')

const gate1 = judgeFixDispatchGate(gateRoot, 'SCN-8A521B7D')
check('G1a SCN-8A521B7D（BLOCKED_BY_SPEC）→ 阻断派单', gate1.blocked === true && gate1.status === 'BLOCKED_BY_SPEC', JSON.stringify(gate1))
const gate2 = judgeFixDispatchGate(gateRoot, 'SCN-WAIVED001')
check('G1b WAIVED 场景 → 阻断派单', gate2.blocked === true && gate2.status === 'WAIVED', JSON.stringify(gate2))
for (const id of ['SCN-E081F289', 'SCN-FAB823EC', 'SCN-6D7E1E68']) {
  const gate = judgeFixDispatchGate(gateRoot, id)
  check(`G2 ${id}（合法 FAILED，无裁决）→ 不阻断`, gate.blocked === false, JSON.stringify(gate))
}
const gateUnknown = judgeFixDispatchGate(gateRoot, 'SCN-NOTEXIST9')
check('G3a registry 中不存在的场景 → 放行（不误拦）', gateUnknown.blocked === false, JSON.stringify(gateUnknown))
const noRegistryRoot = mkdtempSync(join(tmpdir(), 'moonglass-fix-dispatch-gate-empty-'))
const gateNoRegistry = judgeFixDispatchGate(noRegistryRoot, 'SCN-8A521B7D')
check('G3b registry 缺失 → 放行（防御性）', gateNoRegistry.blocked === false, JSON.stringify(gateNoRegistry))
// 大小写不敏感
const gateLower = judgeFixDispatchGate(gateRoot, 'scn-8a521b7d')
check('G3c scenarioId 大小写不敏感匹配', gateLower.blocked === true, JSON.stringify(gateLower))

rmSync(gateRoot, { recursive: true, force: true })
rmSync(noRegistryRoot, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
