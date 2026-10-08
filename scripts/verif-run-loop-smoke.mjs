// VERIF-RUN-LOOP 批 2/批 3（设计文档 §3.2/§4/§5/§6/§9.1/§9.2/§10）：验证运行循环纯函数核心的
// 节拍推导映射（posture 夹具→动作类型）、预算各超限分支、无进展计数熔断、
// 暂停/恢复迁移、账本归一化与 lastBeats 截断、重启对账迁移、证据指纹，
// 以及批 3 决策层：升级 prompt/直接熔断原因白名单/decide 迁移（批准续跑、否决转熔断）。
// 与 verification-guidance-smoke 同模式：node:module 注册别名钩子后动态 import TS 源码。
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
const { utimesSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const {
  DEFAULT_MAX_BEATS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_WALL_MINUTES,
  DEFAULT_NO_PROGRESS_LIMIT,
  RUN_LOOP_DECISION_PENDING_REASON,
  VERIF_RUN_LOOP_LAST_BEATS_LIMIT,
  VERIF_RUN_LOOP_PLANNING_PROMPT,
  applyRunLoopBudgetOverrides,
  applyRunLoopPause,
  applyRunLoopResume,
  buildRunLoopEscalationPrompt,
  checkRunLoopBudget,
  classifyRunLoopAction,
  classifyRunLoopStartGuard,
  closureCountsOf,
  createRunLoopLedger,
  deriveRunLoopWave,
  evidenceFingerprint,
  isDirectBreakerReason,
  isRunLoopSuperseded,
  judgeRunLoopAdvanced,
  noProgressStreak,
  planDecideRunLoopTransition,
  planRunLoopBeat,
  readRunLoopPosture,
  readVerifRunLoopLedger,
  reconcileRunLoopAfterRestart,
  recordRunLoopBeat,
  resetRunLoopWallClock,
  resolveRunLoopStartOptions,
  runLoopConsumption,
  runLoopEscalationTitle,
  runLoopTranslate,
  updateVerifRunLoopLedger,
  validateRunLoopBudgetOverrides,
  writeVerifRunLoopLedger
} = await import('../src/main/services/verif-run-loop.ts')

const dir = mkdtempSync(join(tmpdir(), 'moonglass-verif-run-loop-'))
const workspace = join(dir, 'ws')
mkdirSync(join(workspace, 'verification', 'results'), { recursive: true })
mkdirSync(join(workspace, 'verification', 'intelligence'), { recursive: true })
const readLoopFile = () => JSON.parse(readFileSync(join(workspace, 'verification', 'results', 'run-loop.json'), 'utf-8'))

// ── A. 拍决策推导映射（posture 夹具 → 动作类型，规则层 §4.2）──

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

// A1. 回归失败 → fix-regressions（P0 最高优先级）
const failedFixture = { ...cleanBase, regressions: [{ passed: false, testsTotal: 4, coverage: {} }] }
const failedPlan = planRunLoopBeat({ state: failedFixture, generatedAt: '2026-09-29T01:00:00.000Z' })
assert.equal(failedPlan.kind, 'derive')
assert.equal(failedPlan.action.id, 'fix-regressions')
assert.equal(failedPlan.action.priority, 'P0')
assert.ok(failedPlan.action.title.includes('回归'))

// A2. W1 波段进行中 + 条款未覆盖 → wave-w1（批次类）
const w1Fixture = {
  ...cleanBase,
  waveProgress: [{ id: 'W1', label: 'W1 基础功能', status: 'in-progress', scenarioCount: 4, passedCount: 1, specClauseTotal: 4, specClauseCovered: 1 }],
  specMapping: { clauseTotal: 4, coveredClause: 1, clauses: [] }
}
const w1Plan = planRunLoopBeat({ state: w1Fixture, generatedAt: null })
assert.equal(w1Plan.kind, 'derive')
assert.equal(w1Plan.action.id, 'wave-w1')

// A3. C6 工具证据缺失（blocking）→ run-batch（批次类）
const c6Fixture = {
  ...cleanBase,
  verificationIntents: [{ id: 'VI-1', scenarioId: 'SCN-AAAAAAAA', objective: '验证 fifo 复位', status: 'OPEN', priority: 0.9, recommendedMethods: ['simulation'], evidence: [] }],
  coverageHoles: [{ scenarioId: 'SCN-AAAAAAAA', classification: 'C6_TOOL_INSTRUMENTATION', reason: '未执行', recommendedAction: '执行', blocking: true }]
}
const c6Plan = planRunLoopBeat({ state: c6Fixture, generatedAt: null })
assert.equal(c6Plan.kind, 'derive')
assert.equal(c6Plan.action.id, 'run-batch')

// A4. 全闭环（mutation PASS、无失败）→ signoff-review
const closedFixture = {
  ...cleanBase,
  verificationIntents: [{ id: 'VI-1', scenarioId: 'SCN-AAAAAAAA', objective: '验证 fifo 复位', status: 'VERIFIED', priority: 0.9, recommendedMethods: ['simulation'], evidence: ['e.xml'] }]
}
const closedPlan = planRunLoopBeat({ state: closedFixture, generatedAt: '2026-09-29T02:00:00.000Z' })
assert.equal(closedPlan.kind, 'derive')
assert.equal(closedPlan.action.id, 'signoff-review')

// A5. 无态势 → planning（W0 规划拍）
assert.deepEqual(planRunLoopBeat({ state: null, generatedAt: null }), { kind: 'planning' })

// A6. 主进程 tr 注入：zh-CN 查表 + {param} 插值 + 缺键回退 key
assert.equal(runLoopTranslate('verification.actionTexts.continueW1Title'), '继续基础功能验证')
const interpolated = runLoopTranslate('verification.actionTexts.continueW1Detail', { covered: 1, total: 4 })
assert.ok(interpolated.includes('1/4'), `插值失败: ${interpolated}`)
assert.equal(runLoopTranslate('verification.nonexistent.key'), 'verification.nonexistent.key')

// ── B. 动作派发映射（批次类委托内层循环；signoff-review 独立出口；其余任务会话）──

assert.equal(classifyRunLoopAction('run-batch'), 'batch-loop')
assert.equal(classifyRunLoopAction('wave-w1'), 'batch-loop')
assert.equal(classifyRunLoopAction('wave-w2'), 'batch-loop')
assert.equal(classifyRunLoopAction('signoff-review'), 'signoff-review')
assert.equal(classifyRunLoopAction('clarify-spec'), 'task-session')
assert.equal(classifyRunLoopAction('fix-regressions'), 'task-session')

// ── C. 预算熔断各分支（§6）──

const baseOptions = resolveRunLoopStartOptions()
const makeLedger = (mutate = () => {}) => {
  const ledger = createRunLoopLedger(baseOptions, '2026-09-29T00:00:00.000Z', true)
  mutate(ledger)
  return ledger
}
const NOW = '2026-09-29T01:00:00.000Z'

// C1. 连续无进展 ≥ 上限 → rule-stall（预算健康时）；硬预算超限时硬预算优先（见 C1b）
const stalled = makeLedger((ledger) => {
  ledger.lastBeats = [
    { beat: 3, summary: 's', decisionId: '', verdict: 'no-progress', advanced: false },
    { beat: 2, summary: 's', decisionId: '', verdict: 'no-progress', advanced: false },
    { beat: 1, summary: 's', decisionId: '', verdict: 'no-progress', advanced: false }
  ]
})
const stallCheck = checkRunLoopBudget(stalled, DEFAULT_NO_PROGRESS_LIMIT, NOW)
assert.equal(stallCheck.exceeded, true)
assert.equal(stallCheck.reason, 'rule-stall')
assert.ok(stallCheck.detail.includes('3'))

// C1b. 硬预算先于规则空转（实测：streak 先命中时 token 烧到 146% 也不熔断，硬预算被遮蔽）
const stalledAndBurned = makeLedger((ledger) => {
  ledger.budget.tokensUsed = DEFAULT_MAX_TOKENS
  ledger.lastBeats = stalled.lastBeats
})
assert.equal(checkRunLoopBudget(stalledAndBurned, DEFAULT_NO_PROGRESS_LIMIT, NOW).reason, 'max-tokens')

// C2. 有进展打头 → 无进展计数清零，不熔断
const progressed = makeLedger((ledger) => {
  ledger.lastBeats = [
    { beat: 4, summary: 's', decisionId: '', verdict: 'advanced', advanced: true },
    { beat: 3, summary: 's', decisionId: '', verdict: 'no-progress', advanced: false },
    { beat: 2, summary: 's', decisionId: '', verdict: 'no-progress', advanced: false },
    { beat: 1, summary: 's', decisionId: '', verdict: 'no-progress', advanced: false }
  ]
})
assert.equal(noProgressStreak(progressed.lastBeats), 0)
assert.equal(checkRunLoopBudget(progressed, DEFAULT_NO_PROGRESS_LIMIT, NOW).exceeded, false)

// C3. 拍数超限 → max-beats
const beatOut = makeLedger((ledger) => { ledger.budget.beats = DEFAULT_MAX_BEATS })
const beatCheck = checkRunLoopBudget(beatOut, DEFAULT_NO_PROGRESS_LIMIT, NOW)
assert.equal(beatCheck.reason, 'max-beats')

// C4. token 超限 → max-tokens
const tokenOut = makeLedger((ledger) => { ledger.budget.tokensUsed = DEFAULT_MAX_TOKENS })
assert.equal(checkRunLoopBudget(tokenOut, DEFAULT_NO_PROGRESS_LIMIT, NOW).reason, 'max-tokens')

// C5. 墙钟超限 → max-wall（240 分钟整命中）
const wallOut = makeLedger((ledger) => { ledger.budget.startedAt = '2026-09-28T20:00:00.000Z' })
const wallCheck = checkRunLoopBudget(wallOut, DEFAULT_NO_PROGRESS_LIMIT, NOW)
assert.equal(wallCheck.reason, 'max-wall')
assert.ok(wallCheck.detail.includes('240'))
// 墙钟未超 → 不熔断
const wallOk = makeLedger((ledger) => { ledger.budget.startedAt = '2026-09-29T00:30:00.000Z' })
assert.equal(checkRunLoopBudget(wallOk, DEFAULT_NO_PROGRESS_LIMIT, NOW).exceeded, false)

// C6. 全部达标 → 不熔断
assert.equal(checkRunLoopBudget(makeLedger(), DEFAULT_NO_PROGRESS_LIMIT, NOW).exceeded, false)

// ── D. 推进判定（闭环计数对比，多信号防误判 §11）──

const countsFixture = (overrides) => ({
  verificationIntents: [
    { id: 'VI-1', scenarioId: 'SCN-1', objective: 'o', status: 'OPEN', priority: 1, recommendedMethods: [], evidence: [] },
    { id: 'VI-2', scenarioId: 'SCN-2', objective: 'o', status: 'VERIFIED', priority: 1, recommendedMethods: [], evidence: [] }
  ],
  coverageHoles: [{ scenarioId: 'SCN-1', classification: 'C6_TOOL_INSTRUMENTATION', reason: 'r', recommendedAction: 'a', blocking: true }],
  specMapping: { clauseTotal: 4, coveredClause: 1 },
  regressions: [{ passed: false, testsTotal: 2, coverage: {} }],
  ...overrides
})
const beforeCounts = closureCountsOf(countsFixture({}))
assert.deepEqual(beforeCounts, { openIntents: 1, blockingHoles: 1, coveredClauses: 1, failedRegressions: 1 })
// open intents 减少 → 推进
assert.equal(judgeRunLoopAdvanced(countsFixture({}), countsFixture({
  verificationIntents: [
    { id: 'VI-1', scenarioId: 'SCN-1', objective: 'o', status: 'VERIFIED', priority: 1, recommendedMethods: [], evidence: [] },
    { id: 'VI-2', scenarioId: 'SCN-2', objective: 'o', status: 'VERIFIED', priority: 1, recommendedMethods: [], evidence: [] }
  ]
})), true)
// 条款覆盖增加 → 推进
assert.equal(judgeRunLoopAdvanced(countsFixture({}), countsFixture({ specMapping: { clauseTotal: 4, coveredClause: 2 } })), true)
// 阻断 holes 减少 → 推进
assert.equal(judgeRunLoopAdvanced(countsFixture({}), countsFixture({ coverageHoles: [] })), true)
// 回归失败减少 → 推进
assert.equal(judgeRunLoopAdvanced(countsFixture({}), countsFixture({ regressions: [{ passed: true, testsTotal: 2, coverage: {} }] })), true)
// 计数不变 → 无进展
assert.equal(judgeRunLoopAdvanced(countsFixture({}), countsFixture({})), false)
// 态势从无到有（规划拍产出）→ 推进；有到无 → 无进展
assert.equal(judgeRunLoopAdvanced(null, countsFixture({})), true)
assert.equal(judgeRunLoopAdvanced(countsFixture({}), null), false)
assert.equal(judgeRunLoopAdvanced(null, null), false)

// ── E. 暂停/恢复迁移（§5.1 暂停即落盘）──

const pauseLedger = createRunLoopLedger(baseOptions, NOW, true)
applyRunLoopPause(pauseLedger, { kind: 'human', reason: 'no-rule-action', detail: 'd', since: NOW })
assert.equal(pauseLedger.state, 'paused-human')
assert.equal(pauseLedger.pause.kind, 'human')
assert.equal(pauseLedger.pause.reason, 'no-rule-action')
assert.deepEqual(pauseLedger.pause.pendingItems, [])
assert.equal(pauseLedger.current, null)
applyRunLoopPause(pauseLedger, { kind: 'breaker', reason: 'max-beats', detail: 'd', pendingItems: ['a'], since: NOW })
assert.equal(pauseLedger.state, 'paused-breaker')
assert.deepEqual(pauseLedger.pause.pendingItems, ['a'])
applyRunLoopResume(pauseLedger)
assert.equal(pauseLedger.state, 'running')
assert.equal(pauseLedger.pause, null)

// ── F. 账本读写：归一化、原子写、lastBeats 截断 ──

// F1. 无文件 → null；update 从初值重建
assert.equal(readVerifRunLoopLedger(workspace), null)
updateVerifRunLoopLedger(workspace, (ledger) => { ledger.state = 'running' })
let file = readLoopFile()
assert.equal(file.version, 1)
assert.equal(file.state, 'running')
assert.ok(typeof file.updatedAt === 'string' && file.updatedAt.length > 0)
assert.equal(file.budget.maxBeats, DEFAULT_MAX_BEATS)
assert.equal(file.budget.maxTokens, DEFAULT_MAX_TOKENS)
assert.equal(file.budget.maxWallMinutes, DEFAULT_MAX_WALL_MINUTES)

// F2. 启动初值：有态势 → running；无态势 → planning + W0
assert.equal(createRunLoopLedger(baseOptions, NOW, true).state, 'running')
const planningLedger = createRunLoopLedger(baseOptions, NOW, false)
assert.equal(planningLedger.state, 'planning')
assert.equal(planningLedger.wave, 'W0')

// F3. recordRunLoopBeat：拍数/预算累加 + lastBeats 新在前 + ≤20 截断
updateVerifRunLoopLedger(workspace, (ledger) => {
  ledger.lastBeats = []
  ledger.beat = 0
  ledger.budget.beats = 0
  ledger.budget.tokensUsed = 0
  for (let index = 1; index <= 25; index += 1) {
    recordRunLoopBeat(ledger, { beat: index, summary: `拍 ${index}`, decisionId: '', verdict: 'advanced', advanced: true }, 100)
  }
})
file = readLoopFile()
assert.equal(VERIF_RUN_LOOP_LAST_BEATS_LIMIT, 20)
assert.equal(file.lastBeats.length, 20)
assert.equal(file.lastBeats[0].beat, 25)
assert.equal(file.lastBeats[19].beat, 6)
assert.equal(file.beat, 25)
assert.equal(file.budget.beats, 25)
assert.equal(file.budget.tokensUsed, 2500)

// F4. 损坏文件 → read null；update 重建
writeFileSync(join(workspace, 'verification', 'results', 'run-loop.json'), '{broken', 'utf-8')
assert.equal(readVerifRunLoopLedger(workspace), null)
updateVerifRunLoopLedger(workspace, (ledger) => { ledger.state = 'paused-human' })
assert.equal(readLoopFile().state, 'paused-human')

// F5. 缺字段/未知值归一：未知 state → idle，非法 lastBeats → 空，缺 budget → 默认值
writeFileSync(join(workspace, 'verification', 'results', 'run-loop.json'), JSON.stringify({
  state: 'bogus', wave: 'W9', beat: 'x', lastBeats: 'nope',
  current: { kind: 1 }, pause: 'p', budget: { beats: -1 }
}), 'utf-8')
const normalized = readVerifRunLoopLedger(workspace)
assert.equal(normalized.state, 'idle')
assert.equal(normalized.wave, null)
assert.equal(normalized.beat, 0)
assert.deepEqual(normalized.lastBeats, [])
// current 为对象但字段非法 → 缺字段归一为默认形态（与 verif-loop-ledger 同风格，不置 null）
assert.equal(normalized.current.kind, '1')
assert.equal(normalized.current.actionId, null)
assert.equal(normalized.current.source, 'rule')
assert.equal(normalized.pause, null)
assert.equal(normalized.budget.beats, 0)
assert.equal(normalized.budget.maxBeats, DEFAULT_MAX_BEATS)

// ── G. 重启对账（§11：执行中各态 → paused-breaker app-restart，不自动续跑）──

const reconcileFixtures = ['running', 'judging', 'repairing', 'planning', 'signoff-review', 'gate-check']
for (const state of reconcileFixtures) {
  updateVerifRunLoopLedger(workspace, (ledger) => {
    applyRunLoopResume(ledger)
    ledger.state = state
    ledger.current = { kind: 'task-session', actionId: 'fix-regressions', sessionName: 's', dispatchedAt: NOW, source: 'rule', decisionId: '' }
  })
  const reconciled = reconcileRunLoopAfterRestart(workspace)
  assert.equal(reconciled.state, 'paused-breaker', `状态 ${state} 未对账为暂停熔断`)
  assert.equal(reconciled.pause.reason, 'app-restart')
  assert.ok(reconciled.pause.detail.includes('应用重启'))
  assert.equal(reconciled.current, null)
  assert.equal(reconciled.pause.pendingItems.length, 1)
  assert.ok(reconciled.pause.pendingItems[0].includes('fix-regressions'))
}
// 已暂停/终态原样保留，不重复改写
for (const state of ['paused-human', 'paused-breaker', 'completed', 'stopped', 'idle']) {
  updateVerifRunLoopLedger(workspace, (ledger) => { ledger.state = state; ledger.pause = null })
  const untouched = reconcileRunLoopAfterRestart(workspace)
  assert.equal(untouched.state, state)
  assert.equal(untouched.pause, null)
}
// 无账本 → null
mkdirSync(join(dir, 'ws-empty'), { recursive: true })
assert.equal(reconcileRunLoopAfterRestart(join(dir, 'ws-empty')), null)

// ── H. 态势读取（posture 优先，缺 verificationIntents 回退 state.json）──

const wsPosture = join(dir, 'ws-posture')
mkdirSync(join(wsPosture, 'verification', 'intelligence'), { recursive: true })
assert.deepEqual(readRunLoopPosture(wsPosture), { state: null, generatedAt: null })
// posture 被覆盖成摘要（缺 verificationIntents）→ 回退 verification-state.json
writeFileSync(join(wsPosture, 'verification', 'intelligence', 'verification-posture.json'), JSON.stringify({ generatedAt: '2026-09-29T03:00:00.000Z', summary: '摘要' }), 'utf-8')
writeFileSync(join(wsPosture, 'verification', 'intelligence', 'verification-state.json'), JSON.stringify({ generatedAt: '2026-09-29T02:00:00.000Z', verificationIntents: [] }), 'utf-8')
const fallbackPosture = readRunLoopPosture(wsPosture)
assert.notEqual(fallbackPosture.state, null)
assert.equal(fallbackPosture.generatedAt, '2026-09-29T02:00:00.000Z')
// posture 正常 → 直接用（不再回退）
writeFileSync(join(wsPosture, 'verification', 'intelligence', 'verification-posture.json'), JSON.stringify({ generatedAt: '2026-09-29T03:00:00.000Z', verificationIntents: [] }), 'utf-8')
const directPosture = readRunLoopPosture(wsPosture)
assert.equal(directPosture.generatedAt, '2026-09-29T03:00:00.000Z')

// ── I. 证据指纹（§5.2 证据触发恢复；账本自身写入不触发）──

const wsEvidence = join(dir, 'ws-evidence')
mkdirSync(join(wsEvidence, 'verification', 'results'), { recursive: true })
const fingerprint0 = evidenceFingerprint(wsEvidence)
assert.equal(fingerprint0, '')
const evidenceFile = join(wsEvidence, 'verification', 'results', 'scenario_hits.json')
writeFileSync(evidenceFile, JSON.stringify({ scenarios: [] }), 'utf-8')
const fingerprint1 = evidenceFingerprint(wsEvidence)
assert.notEqual(fingerprint1, fingerprint0)
assert.ok(fingerprint1.includes('scenario_hits.json'))
// mtime 变化 → 指纹变化
const future = new Date(Date.now() + 60_000)
utimesSync(evidenceFile, future, future)
assert.notEqual(evidenceFingerprint(wsEvidence), fingerprint1)
// 循环账本自身写入 → 指纹不变（防止自我触发恢复）
writeFileSync(join(wsEvidence, 'verification', 'results', 'run-loop.json'), JSON.stringify({ state: 'paused-human' }), 'utf-8')
assert.equal(evidenceFingerprint(wsEvidence), evidenceFingerprint(wsEvidence))
assert.ok(!evidenceFingerprint(wsEvidence).includes('run-loop.json'))

// ── J. 启动选项归一 + 波段推导 + 规划 prompt 常量 ──

const custom = resolveRunLoopStartOptions({ maxBeats: 10, maxTokens: 0, maxWallMinutes: -5, noProgressLimit: 2.9 })
assert.equal(custom.maxBeats, 10)
assert.equal(custom.maxTokens, DEFAULT_MAX_TOKENS) // 0 非法 → 默认
assert.equal(custom.maxWallMinutes, DEFAULT_MAX_WALL_MINUTES) // 负数非法 → 默认
assert.equal(custom.noProgressLimit, 2) // 截断
assert.equal(resolveRunLoopStartOptions().maxBeats, DEFAULT_MAX_BEATS)
assert.equal(deriveRunLoopWave({ ...cleanBase, waveProgress: [{ id: 'W2', label: 'W2', status: 'in-progress', scenarioCount: 3, passedCount: 1 }] }), 'W2')
assert.equal(deriveRunLoopWave({ ...cleanBase, waveProgress: [{ id: 'W1', label: 'W1', status: 'done', scenarioCount: 3, passedCount: 3 }] }), null)
assert.equal(deriveRunLoopWave(null), null)
assert.ok(VERIF_RUN_LOOP_PLANNING_PROMPT.includes('build_verification_intelligence'))
assert.ok(VERIF_RUN_LOOP_PLANNING_PROMPT.includes('禁止运行仿真'))

// ── K. 批 3 决策层：升级 prompt / 直接熔断白名单 / decide 迁移（§3.2/§3.3）──

// K1. 决策升级 prompt：读压缩态势四账本 + propose_run_decision 提交提案 + trigger 口径
const stallPrompt = buildRunLoopEscalationPrompt('rule-stall', '连续 3 拍无进展')
assert.ok(stallPrompt.includes('verification/intelligence/execution-summary.json'))
assert.ok(stallPrompt.includes('verification/results/run-loop.json'))
assert.ok(stallPrompt.includes('verification/results/decision-ledger.json'))
assert.ok(stallPrompt.includes('verification/results/diagnostic-control.json'))
assert.ok(stallPrompt.includes('propose_run_decision'))
assert.ok(stallPrompt.includes("'rule-stall'"))
assert.ok(stallPrompt.includes('归因'))
assert.ok(stallPrompt.includes('expectedOutput'))
assert.ok(stallPrompt.includes('stopCriteria'))
const recoveryPrompt = buildRunLoopEscalationPrompt('breaker-recovery', 'rtl-fix-wait-timeout：等待修复超时')
assert.ok(recoveryPrompt.includes('熔断'))
assert.ok(recoveryPrompt.includes("'breaker-recovery'"))
assert.equal(runLoopEscalationTitle('rule-stall'), '验证循环决策升级（规则空转）')
assert.equal(runLoopEscalationTitle('breaker-recovery'), '验证循环决策升级（熔断恢复）')

// K2. 直接熔断白名单（不派发升级会话）：app-restart/manual-override/预算类；
//     rule-stall/rtl-fix-wait-timeout/decision-rejected/loop-error → 走决策升级（breaker-recovery）
for (const reason of ['app-restart', 'manual-override', 'max-beats', 'max-tokens', 'max-wall']) {
  assert.equal(isDirectBreakerReason(reason), true, `${reason} 应直接熔断`)
}
for (const reason of ['rule-stall', 'rtl-fix-wait-timeout', 'decision-rejected', 'loop-error', 'budget']) {
  assert.equal(isDirectBreakerReason(reason), false, `${reason} 应走决策升级`)
}

// K3. rule-stall 预算判定不变（迁移在驱动层：升级派发替代直接熔断，见 AgentService.dispatchRunLoopEscalation）
const stallLedger = makeLedger((ledger) => {
  ledger.lastBeats = [
    { beat: 3, summary: 's', decisionId: 'DEC-00000003', verdict: 'no-progress', advanced: false },
    { beat: 2, summary: 's', decisionId: 'DEC-00000002', verdict: 'no-progress', advanced: false },
    { beat: 1, summary: 's', decisionId: 'DEC-00000001', verdict: 'no-progress', advanced: false }
  ]
})
const stallReason = checkRunLoopBudget(stallLedger, DEFAULT_NO_PROGRESS_LIMIT, NOW)
assert.equal(stallReason.exceeded, true)
assert.equal(stallReason.reason, 'rule-stall')

// K4. decide 迁移：循环停在 llm-decision-pending → 批准=approve-and-resume（续跑执行该决策）；
//     否决=reject-and-breaker（转 paused-breaker decision-rejected）
const waitingPause = {
  state: 'paused-human',
  pause: { kind: 'human', reason: RUN_LOOP_DECISION_PENDING_REASON, detail: 'd', pendingItems: [], since: NOW }
}
assert.equal(planDecideRunLoopTransition(waitingPause, 'approved').kind, 'approve-and-resume')
assert.equal(planDecideRunLoopTransition(waitingPause, 'rejected').kind, 'reject-and-breaker')
assert.equal(RUN_LOOP_DECISION_PENDING_REASON, 'llm-decision-pending')
// K5. 循环不在等待（运行中 / 其他暂停 / 无账本）→ 只记账，不触发恢复/熔断
assert.equal(planDecideRunLoopTransition({ state: 'running', pause: null }, 'approved').kind, 'approve-record-only')
assert.equal(planDecideRunLoopTransition({ state: 'running', pause: null }, 'rejected').kind, 'reject-record-only')
assert.equal(planDecideRunLoopTransition({ state: 'paused-human', pause: { kind: 'human', reason: 'gate-blocked', detail: 'd', pendingItems: [], since: NOW } }, 'approved').kind, 'approve-record-only')
assert.equal(planDecideRunLoopTransition({ state: 'paused-breaker', pause: { kind: 'breaker', reason: 'max-beats', detail: 'd', pendingItems: [], since: NOW } }, 'rejected').kind, 'reject-record-only')
assert.equal(planDecideRunLoopTransition(null, 'approved').kind, 'approve-record-only')
assert.equal(planDecideRunLoopTransition(null, 'rejected').kind, 'reject-record-only')
// K6. 决策账本位于 verification/results/ 下：证据指纹覆盖 decision-ledger.json 变化（恢复触发源之一）
const wsDecisionEvidence = join(dir, 'ws-decision-evidence')
mkdirSync(join(wsDecisionEvidence, 'verification', 'results'), { recursive: true })
const fingerprintBefore = evidenceFingerprint(wsDecisionEvidence)
writeFileSync(join(wsDecisionEvidence, 'verification', 'results', 'decision-ledger.json'), JSON.stringify({ version: 1, decisions: [] }), 'utf-8')
assert.notEqual(evidenceFingerprint(wsDecisionEvidence), fingerprintBefore)
assert.ok(evidenceFingerprint(wsDecisionEvidence).includes('decision-ledger.json'))

// ── L 段：loopId 代际守卫（僵尸循环修复）──
// L1. createRunLoopLedger 生成非空 loopId 且两次创建不同
const ledgerA = createRunLoopLedger(resolveRunLoopStartOptions(), NOW, false)
const ledgerB = createRunLoopLedger(resolveRunLoopStartOptions(), NOW, false)
assert.ok(ledgerA.loopId.startsWith('LOOP-'))
assert.notEqual(ledgerA.loopId, ledgerB.loopId)
// L2. 旧账本缺 loopId → 归一化为 ''（兼容 v0 账本）
const wsLegacy = join(dir, 'ws-legacy-loop')
mkdirSync(join(wsLegacy, 'verification', 'results'), { recursive: true })
const legacyPayload = JSON.parse(JSON.stringify(ledgerA))
delete legacyPayload.loopId
writeFileSync(join(wsLegacy, 'verification', 'results', 'run-loop.json'), JSON.stringify(legacyPayload), 'utf-8')
assert.equal(readVerifRunLoopLedger(wsLegacy).loopId, '')
// L3. 启动守卫对账：无句柄放行；句柄+活跃账本拒绝；句柄+无账本/终态/idle → 僵尸清场
assert.equal(classifyRunLoopStartGuard(false, null), 'ok')
assert.equal(classifyRunLoopStartGuard(true, { ...ledgerA, state: 'running' }), 'reject-running')
assert.equal(classifyRunLoopStartGuard(true, null), 'zombie-cleanup')
assert.equal(classifyRunLoopStartGuard(true, { ...ledgerA, state: 'stopped' }), 'zombie-cleanup')
assert.equal(classifyRunLoopStartGuard(true, { ...ledgerA, state: 'completed' }), 'zombie-cleanup')
assert.equal(classifyRunLoopStartGuard(true, { ...ledgerA, state: 'idle' }), 'zombie-cleanup')
// L4. 代际不符判定：账本与当前 loopId 不同→superseded；任一侧为空串→不判（兼容旧账本/无守卫调用方）
assert.equal(isRunLoopSuperseded(null, 'LOOP-A'), false)
assert.equal(isRunLoopSuperseded({ ...ledgerA, loopId: 'LOOP-A' }, 'LOOP-A'), false)
assert.equal(isRunLoopSuperseded({ ...ledgerA, loopId: 'LOOP-A' }, 'LOOP-B'), true)
assert.equal(isRunLoopSuperseded({ ...ledgerA, loopId: '' }, 'LOOP-B'), false)
assert.equal(isRunLoopSuperseded({ ...ledgerA, loopId: 'LOOP-A' }, ''), false)

// ── M 段：继续时抬高预算上限 + 手动继续墙钟开窗重置（实测：预算吃满直接继续会立即再次熔断）──
// M1. noProgressLimit/wallResetBase 入账本并存活读写往返
const budgetLedger = createRunLoopLedger(resolveRunLoopStartOptions({ noProgressLimit: 7 }), NOW, false)
assert.equal(budgetLedger.budget.noProgressLimit, 7)
assert.equal(budgetLedger.budget.wallResetBase, 0)
const wsBudget = join(dir, 'ws-budget')
mkdirSync(join(wsBudget, 'verification', 'results'), { recursive: true })
writeVerifRunLoopLedger(wsBudget, budgetLedger)
assert.equal(readVerifRunLoopLedger(wsBudget).budget.noProgressLimit, 7)
// M2. 旧账本缺新字段 → 归一化为默认值
const legacyBudgetPayload = JSON.parse(JSON.stringify(budgetLedger))
delete legacyBudgetPayload.budget.noProgressLimit
delete legacyBudgetPayload.budget.wallResetBase
writeFileSync(join(wsBudget, 'verification', 'results', 'run-loop.json'), JSON.stringify(legacyBudgetPayload), 'utf-8')
const legacyRead = readVerifRunLoopLedger(wsBudget)
assert.equal(legacyRead.budget.noProgressLimit, DEFAULT_NO_PROGRESS_LIMIT)
assert.equal(legacyRead.budget.wallResetBase, 0)
// M3. 消耗量折算：步数/token 取账本值，墙钟按当前窗口折分钟
const consumed = { ...budgetLedger, budget: { ...budgetLedger.budget, beats: 50, tokensUsed: 3_000_000, startedAt: '2026-10-05T10:00:00.000Z' } }
assert.deepEqual(runLoopConsumption(consumed, '2026-10-05T14:30:00.000Z'), { beats: 50, tokensUsed: 3_000_000, elapsedMinutes: 270 })
// M4. 上限校验：步数/token 等于或低于当前消耗一律拒绝；未提供维度跳过
assert.equal(validateRunLoopBudgetOverrides(consumed, { maxBeats: 50 }, '2026-10-05T14:30:00.000Z').ok, false)
assert.equal(validateRunLoopBudgetOverrides(consumed, { maxTokens: 2_999_999 }, '2026-10-05T14:30:00.000Z').ok, false)
assert.equal(validateRunLoopBudgetOverrides(consumed, { maxBeats: 200, maxTokens: 20_000_000, maxWallMinutes: 480 }, '2026-10-05T14:30:00.000Z').ok, true)
assert.equal(validateRunLoopBudgetOverrides(consumed, undefined, '2026-10-05T14:30:00.000Z').ok, true)
// M5. 手动继续的墙钟开窗重置：历史滚入 wallResetBase，窗口归零，重置后墙钟上限任意正值可过校验
const resetLedger = JSON.parse(JSON.stringify(consumed))
resetRunLoopWallClock(resetLedger, '2026-10-05T14:30:00.000Z')
assert.equal(resetLedger.budget.wallResetBase, 270)
assert.equal(resetLedger.budget.startedAt, '2026-10-05T14:30:00.000Z')
assert.equal(runLoopConsumption(resetLedger, '2026-10-05T14:45:00.000Z').elapsedMinutes, 15)
assert.equal(validateRunLoopBudgetOverrides(resetLedger, { maxWallMinutes: 240 }, '2026-10-05T14:30:00.000Z').ok, true)
// M6. applyRunLoopBudgetOverrides：写回提供的字段、未提供的保持原值、计数不归零
const appliedLedger = JSON.parse(JSON.stringify(consumed))
applyRunLoopBudgetOverrides(appliedLedger, { maxBeats: 200, noProgressLimit: 5 })
assert.equal(appliedLedger.budget.maxBeats, 200)
assert.equal(appliedLedger.budget.noProgressLimit, 5)
assert.equal(appliedLedger.budget.maxTokens, consumed.budget.maxTokens)
assert.equal(appliedLedger.budget.beats, 50)

console.log('verif-run-loop-smoke: OK（拍决策映射/派发映射/预算四分支/无进展熔断/推进判定/暂停恢复/账本归一+截断/重启对账/态势回退/证据指纹/批3升级prompt+直接熔断白名单+decide迁移/决策账本入证据指纹/loopId代际守卫+启动守卫对账/预算抬高校验+noProgressLimit与墙钟开窗重置入账本）')
