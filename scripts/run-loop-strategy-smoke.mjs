// 验证长程循环"战略层"数据面——运行策略确定性触发器 + 收口计划 W1 四判据 + 拍决策策略降权：
// 策略四态触发（converge-first 双条件/steady-regression/deep-dive 回落/normal）、
// 同策略不重复切换（幂等返回，调用方只在变化时记账）、退出条件（触发条件不再成立即回落）、
// closurePlan 四判据（clauses-covered/no-open-failures/no-pending-repairs/signoff-regression，证据不足一律 false）、
// converge-first 拍决策降权（wave 批次类让位修复/根因/诊断类，其余策略完全现状）。
// 与 verif-run-loop-smoke 同模式：node:module 注册别名钩子后动态 import TS 源码。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const { planRunLoopBeat, readVerifRunLoopLedger, writeVerifRunLoopLedger, createRunLoopLedger, resolveRunLoopStartOptions } = await import('../src/main/services/verif-run-loop.ts')
const {
  RUN_LOOP_CLOSURE_CRITERIA_IDS,
  closureRegressionsOf,
  computeClosurePlan,
  evaluateRunLoopStrategy,
  runLoopStrategyTriggerNote,
  stalePassedCountOf
} = await import('../src/main/services/verif-run-forecast.ts')

const j = (judgment) => ({ judgment })
const beat = (advanced) => ({ advanced })
const beats = (...flags) => flags.map(beat)

// ── A. 策略四态触发 ──
// A1. converge-first：近 10 条修复判定非 FIXED 占比 > 0.5
const ratioInput = {
  fixOutcomes: ['UNKNOWN', 'STILL_FAIL', 'UNKNOWN', 'FIXED', 'STILL_FAIL', 'UNKNOWN', 'FIXED', 'STILL_FAIL', 'UNKNOWN', 'FIXED'].map(j),
  lastBeats: beats(true, true),
  stalePassedCount: 0,
  current: 'normal'
}
assert.equal(evaluateRunLoopStrategy(ratioInput), 'converge-first')
const ratioNote = runLoopStrategyTriggerNote(ratioInput)
assert.ok(ratioNote.includes('converge-first'))
assert.ok(ratioNote.includes('占比 0.70'))

// A2. converge-first：近 5 条 ≥3 条非 FIXED（占比 ≤0.5 的另一条件通道）
const last5Input = {
  fixOutcomes: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'FIXED', 'FIXED', 'FIXED', 'FIXED', 'FIXED', 'FIXED', 'FIXED'].map(j),
  lastBeats: beats(true, true),
  stalePassedCount: 0,
  current: 'normal'
}
assert.equal(evaluateRunLoopStrategy(last5Input), 'converge-first')
assert.ok(runLoopStrategyTriggerNote(last5Input).includes('近 5 条'))

// A2b. 边界：占比 = 0.5 不触发（须 > 0.5），近 5 条非 FIXED 2 条也不触发
assert.equal(evaluateRunLoopStrategy({
  fixOutcomes: ['FIXED', 'FIXED', 'FIXED', 'UNKNOWN', 'STILL_FAIL', 'UNKNOWN', 'FIXED', 'STILL_FAIL', 'UNKNOWN', 'FIXED'].map(j),
  lastBeats: beats(true),
  stalePassedCount: 0,
  current: 'normal'
}), 'normal')

// A3. steady-regression：陈旧通过 >0 且近 5 步 advanced ≤1
const steadyInput = {
  fixOutcomes: ['FIXED', 'FIXED'].map(j),
  lastBeats: beats(false, true, false, false, false),
  stalePassedCount: 2,
  current: 'normal'
}
assert.equal(evaluateRunLoopStrategy(steadyInput), 'steady-regression')
const steadyNote = runLoopStrategyTriggerNote(steadyInput)
assert.ok(steadyNote.includes('steady-regression'))
assert.ok(steadyNote.includes('2'))

// A3b. steady-regression 不触发：stale=0（即使回归不动）；或近 5 步 advanced=2（即使 stale>0）
assert.equal(evaluateRunLoopStrategy({ ...steadyInput, stalePassedCount: 0 }), 'normal')
assert.equal(evaluateRunLoopStrategy({ ...steadyInput, lastBeats: beats(true, true, false, false, false) }), 'normal')

// A4. 优先级：converge-first 条件与 steady-regression 条件同时成立 → converge-first
assert.equal(evaluateRunLoopStrategy({
  fixOutcomes: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'].map(j),
  lastBeats: beats(false, false, false),
  stalePassedCount: 3,
  current: 'normal'
}), 'converge-first')

// A5. deep-dive：条件不满足时回落 normal；条件满足时按触发器切换（本函数不产出 deep-dive）
assert.equal(evaluateRunLoopStrategy({
  fixOutcomes: ['FIXED'].map(j), lastBeats: beats(true), stalePassedCount: 0, current: 'deep-dive'
}), 'normal')
assert.equal(evaluateRunLoopStrategy({
  fixOutcomes: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'].map(j),
  lastBeats: beats(true), stalePassedCount: 0, current: 'deep-dive'
}), 'converge-first')

// A6. 无触发 → normal；未触发时触发说明为 null
const calmInput = { fixOutcomes: ['FIXED', 'FIXED', 'FIXED'].map(j), lastBeats: beats(true, true, true), stalePassedCount: 0, current: 'normal' }
assert.equal(evaluateRunLoopStrategy(calmInput), 'normal')
assert.equal(runLoopStrategyTriggerNote(calmInput), null)

// ── B. 不重复切换（幂等）与退出条件 ──
// B1. 当前 converge-first 且条件仍成立 → 保持 converge-first（调用方据此不重复记账）
assert.equal(evaluateRunLoopStrategy({
  fixOutcomes: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'].map(j),
  lastBeats: beats(false),
  stalePassedCount: 0,
  current: 'converge-first'
}), 'converge-first')
// B2. 退出条件：触发条件不再成立 → 回落 normal（converge-first / steady-regression 同口径）
assert.equal(evaluateRunLoopStrategy({
  fixOutcomes: ['FIXED', 'FIXED', 'FIXED', 'FIXED', 'FIXED', 'FIXED'].map(j),
  lastBeats: beats(true),
  stalePassedCount: 0,
  current: 'converge-first'
}), 'normal')
assert.equal(evaluateRunLoopStrategy({
  fixOutcomes: ['FIXED'].map(j),
  lastBeats: beats(true, true, true, true, true),
  stalePassedCount: 0,
  current: 'steady-regression'
}), 'normal')
// B3. 修复判定条数不足窗口：仅 2 条全 UNKNOWN → 占比 1 > 0.5 仍触发（窗口按实际条数计）
assert.equal(evaluateRunLoopStrategy({
  fixOutcomes: ['UNKNOWN', 'UNKNOWN'].map(j), lastBeats: beats(true), stalePassedCount: 0, current: 'normal'
}), 'converge-first')
// B4. steady-regression 不依赖修复判定：空修复判定 → converge-first 占比 0 不触发，
//     但 stale>0 且近 5 步不动 → steady-regression 独立成立
assert.equal(evaluateRunLoopStrategy({
  fixOutcomes: [], lastBeats: beats(false, false, false, false, false), stalePassedCount: 5, current: 'normal'
}), 'steady-regression')

// ── C. 收口计划 W1 四判据 ──
const fullPassPosture = {
  rtlHash: 'H1',
  verificationIntents: [],
  coverageHoles: [],
  regressions: [{ passed: true, testsTotal: 2, coverage: {} }],
  formalResults: [],
  scenarios: [
    { id: 'SCN-1', status: 'VERIFIED', rtlHash: 'H1' },
    { id: 'SCN-2', status: 'FORMAL_PROVED', rtlHash: 'H1' }
  ],
  specMapping: {
    clauseTotal: 2, coveredClause: 2,
    clauses: [
      { clauseId: 'C1', parentId: 'S1', text: 't', status: 'PASSED', intentIds: [], scenarioIds: ['SCN-1'], evidence: ['e.xml'] },
      { clauseId: 'C2', parentId: 'S1', text: 't', status: 'WAIVED', intentIds: [], scenarioIds: [], evidence: [] }
    ]
  },
  waveProgress: [{ id: 'W1', label: 'W1', status: 'in-progress', scenarioCount: 2, passedCount: 2, specClauseTotal: 2, specClauseCovered: 2, stalePassedCount: 0 }]
}
const fixedOnly = ['FIXED'].map(j)
const fullPlan = computeClosurePlan(fullPassPosture, fixedOnly, closureRegressionsOf(fullPassPosture), 'W1')
assert.equal(fullPlan.wave, 'W1')
assert.equal(fullPlan.totalCount, 4)
assert.equal(fullPlan.metCount, 4)
assert.deepEqual(fullPlan.criteria.map((c) => c.id), [...RUN_LOOP_CLOSURE_CRITERIA_IDS])
assert.ok(fullPlan.criteria.every((c) => c.met))

// C1. clauses-covered：stalePassed 条款 → false
const staleClause = JSON.parse(JSON.stringify(fullPassPosture))
staleClause.specMapping.clauses[1].stalePassed = true
const stalePlan = computeClosurePlan(staleClause, fixedOnly, closureRegressionsOf(staleClause), 'W1')
assert.equal(stalePlan.criteria.find((c) => c.id === 'clauses-covered').met, false)
assert.equal(stalePlan.metCount, 3)

// C1b. clauses-covered：明细与 clauseTotal 对账不上（缺一条）→ false
const driftClause = JSON.parse(JSON.stringify(fullPassPosture))
driftClause.specMapping.clauses = driftClause.specMapping.clauses.slice(0, 1)
assert.equal(computeClosurePlan(driftClause, fixedOnly, closureRegressionsOf(driftClause), 'W1').criteria[0].met, false)

// C1c. clauses-covered / signoff-regression：rtlHash 缺失（证据不足）→ false
const noHash = JSON.parse(JSON.stringify(fullPassPosture))
delete noHash.rtlHash
const noHashPlan = computeClosurePlan(noHash, fixedOnly, closureRegressionsOf(noHash), 'W1')
assert.equal(noHashPlan.criteria.find((c) => c.id === 'clauses-covered').met, false)
assert.equal(noHashPlan.criteria.find((c) => c.id === 'signoff-regression').met, false)

// C2. no-open-failures：FAILED 场景 / FAILED 条款 / 回归未通过 → false
const failedScenario = JSON.parse(JSON.stringify(fullPassPosture))
failedScenario.scenarios[0].status = 'FAILED'
const failedScenarioPlan = computeClosurePlan(failedScenario, fixedOnly, closureRegressionsOf(failedScenario), 'W1')
assert.equal(failedScenarioPlan.criteria.find((c) => c.id === 'no-open-failures').met, false)
assert.equal(failedScenarioPlan.criteria.find((c) => c.id === 'signoff-regression').met, false) // FAILED 场景回归未通过
const failedRegression = JSON.parse(JSON.stringify(fullPassPosture))
failedRegression.regressions = [{ passed: false, testsTotal: 2, coverage: {} }]
assert.equal(computeClosurePlan(failedRegression, fixedOnly, closureRegressionsOf(failedRegression), 'W1').criteria[1].met, false)
const failedClause = JSON.parse(JSON.stringify(fullPassPosture))
failedClause.specMapping.clauses[0].status = 'FAILED'
assert.equal(computeClosurePlan(failedClause, fixedOnly, closureRegressionsOf(failedClause), 'W1').criteria[1].met, false)

// C3. no-pending-repairs：STILL_FAIL / UNKNOWN 判定 → false
for (const judgment of ['STILL_FAIL', 'UNKNOWN']) {
  const plan = computeClosurePlan(fullPassPosture, [j(judgment)], closureRegressionsOf(fullPassPosture), 'W1')
  assert.equal(plan.criteria.find((c) => c.id === 'no-pending-repairs').met, false, `${judgment} 应阻断收口`)
}
assert.equal(computeClosurePlan(fullPassPosture, [], closureRegressionsOf(fullPassPosture), 'W1').criteria[2].met, true)

// C4. signoff-regression：场景 rtlHash 与当前不一致 / 场景未通过 / 无场景证据 → false
const staleRtl = JSON.parse(JSON.stringify(fullPassPosture))
staleRtl.scenarios[1].rtlHash = 'H2'
assert.equal(computeClosurePlan(staleRtl, fixedOnly, closureRegressionsOf(staleRtl), 'W1').criteria[3].met, false)
const waivedScenario = JSON.parse(JSON.stringify(fullPassPosture))
waivedScenario.scenarios[1].status = 'WAIVED' // 豁免不是回归通过
assert.equal(computeClosurePlan(waivedScenario, fixedOnly, closureRegressionsOf(waivedScenario), 'W1').criteria[3].met, false)
const noScenarios = JSON.parse(JSON.stringify(fullPassPosture))
delete noScenarios.scenarios
assert.deepEqual(closureRegressionsOf(noScenarios), []) // 证据不足
assert.equal(computeClosurePlan(noScenarios, fixedOnly, [], 'W1').criteria[3].met, false)

// C5. 非 W1 波段：只留 wave 与空 criteria（totalCount 0），不展开
const w2Plan = computeClosurePlan(fullPassPosture, fixedOnly, closureRegressionsOf(fullPassPosture), 'W2')
assert.deepEqual(w2Plan, { wave: 'W2', criteria: [], metCount: 0, totalCount: 0 })
// 无在跑波段（null）→ 按 W1 收口口径预估
assert.equal(computeClosurePlan(fullPassPosture, fixedOnly, closureRegressionsOf(fullPassPosture), null).wave, 'W1')

// C6. stalePassedCountOf：specMapping 优先，回退 W1 waveProgress
assert.equal(stalePassedCountOf(fullPassPosture), 0)
const staleW1 = JSON.parse(JSON.stringify(fullPassPosture))
staleW1.specMapping = undefined
staleW1.waveProgress[0].stalePassedCount = 3
assert.equal(stalePassedCountOf(staleW1), 3)

// ── D. 拍决策策略降权（converge-first：批次类让位修复/根因/诊断类）──
const cleanBase = {
  criticalOpen: [],
  verificationIntents: [],
  specGaps: [],
  coverageHoles: [],
  regressions: [{ passed: true, testsTotal: 4, coverage: {} }],
  formalResults: [],
  mutationAssessment: { status: 'PASS', weightedScore: 1, threshold: 0.8, blockingSurvivors: [] },
  residualRiskRegister: []
}
// D1. W1 进行中 + 回归失败：规则首选 wave-w1（批次类），converge-first 改派 fix-regressions
const w1WithFailure = {
  ...cleanBase,
  waveProgress: [{ id: 'W1', label: 'W1', status: 'in-progress', scenarioCount: 4, passedCount: 1, specClauseTotal: 4, specClauseCovered: 1 }],
  specMapping: { clauseTotal: 4, coveredClause: 1 },
  regressions: [{ passed: false, testsTotal: 4, coverage: {} }]
}
const postureView = { state: w1WithFailure, generatedAt: null }
assert.equal(planRunLoopBeat(postureView).action.id, 'wave-w1')
assert.equal(planRunLoopBeat(postureView, undefined, 'converge-first').action.id, 'fix-regressions')
assert.equal(planRunLoopBeat(postureView, undefined, 'normal').action.id, 'wave-w1')
assert.equal(planRunLoopBeat(postureView, undefined, 'steady-regression').action.id, 'wave-w1')
assert.equal(planRunLoopBeat(postureView, undefined, 'deep-dive').action.id, 'wave-w1')

// D2. 无修复/诊断类共存：converge-first 也不改派（批次类保持首选）
const w1Only = { ...cleanBase, waveProgress: w1WithFailure.waveProgress, specMapping: { clauseTotal: 4, coveredClause: 1 } }
const w1OnlyView = { state: w1Only, generatedAt: null }
assert.equal(planRunLoopBeat(w1OnlyView).action.id, 'wave-w1')
assert.equal(planRunLoopBeat(w1OnlyView, undefined, 'converge-first').action.id, 'wave-w1')

// D3. 修复类即规则首选：converge-first 不影响（无批次可让位）
const failureOnly = { ...cleanBase, regressions: [{ passed: false, testsTotal: 4, coverage: {} }] }
const failureOnlyView = { state: failureOnly, generatedAt: null }
assert.equal(planRunLoopBeat(failureOnlyView).action.id, 'fix-regressions')
assert.equal(planRunLoopBeat(failureOnlyView, undefined, 'converge-first').action.id, 'fix-regressions')

// ── E. 账本归一：closurePlan 读写往返 + 损坏/缺失容错 ──
const dir = mkdtempSync(join(tmpdir(), 'moonglass-run-loop-strategy-'))
const workspace = join(dir, 'ws')
mkdirSync(join(workspace, 'verification', 'results'), { recursive: true })
const ledger = createRunLoopLedger(resolveRunLoopStartOptions(), '2026-10-05T00:00:00.000Z', true)
ledger.closurePlan = {
  wave: 'W1', strategy: 'converge-first', strategySince: '2026-10-05T01:00:00.000Z',
  criteria: [
    { id: 'clauses-covered', met: true },
    { id: 'no-open-failures', met: false },
    { id: 'no-pending-repairs', met: true },
    { id: 'signoff-regression', met: false }
  ],
  metCount: 2, totalCount: 4
}
writeVerifRunLoopLedger(workspace, ledger)
const reread = readVerifRunLoopLedger(workspace)
assert.equal(reread.closurePlan.strategy, 'converge-first')
assert.equal(reread.closurePlan.strategySince, '2026-10-05T01:00:00.000Z')
assert.equal(reread.closurePlan.metCount, 2)
assert.equal(reread.closurePlan.totalCount, 4)
assert.equal(reread.closurePlan.criteria.length, 4)
// 旧账本缺 closurePlan → undefined；损坏/非法值归一（策略回 normal，计数与 criteria 对账）
writeFileSync(join(workspace, 'verification', 'results', 'run-loop.json'), JSON.stringify({ ...ledger, closurePlan: undefined }), 'utf-8')
assert.equal(readVerifRunLoopLedger(workspace).closurePlan, undefined)
writeFileSync(join(workspace, 'verification', 'results', 'run-loop.json'), JSON.stringify({
  ...ledger, closurePlan: { wave: 'W1', strategy: 'bogus', criteria: 'nope' }
}), 'utf-8')
const normalized = readVerifRunLoopLedger(workspace).closurePlan
assert.equal(normalized.strategy, 'normal')
assert.deepEqual(normalized.criteria, [])
assert.equal(normalized.metCount, 0)
assert.equal(normalized.totalCount, 0)
assert.ok(JSON.parse(readFileSync(join(workspace, 'verification', 'results', 'run-loop.json'), 'utf-8')).loopId)

console.log('run-loop-strategy-smoke: OK（converge-first双条件/边界0.5/steady-regression/优先级/deep-dive回落/幂等不重复切换/退出条件/closurePlan四判据+证据不足/非W1空criteria/策略降权三态/账本归一）')
