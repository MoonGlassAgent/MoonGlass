// BOARD-AND-REVIEW-CLOSED-LOOP 片 B（设计文档 §2/§5）：流程看板数据层归一器
// （board-model.ts）冒烟——构造临时 workspace 含各类账本样例，断言统一卡片模型的
// 任务类型映射（batch/rtl-fix/design-review/module-ut/decision/run-loop）、
// 状态五类映射（success/running/needs-fix/pending-human/not-started）、
// 尝试记录（模型/判定/起止/note）、坏 JSON 降级为空集合、会话名前缀阶段归属。
// 与 decision-ledger-smoke 同模式：node:module 注册别名钩子后动态 import TS 源码。
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const { buildBoardModel } = await import('../src/main/services/board-model.ts')

const dir = mkdtempSync(join(tmpdir(), 'moonglass-board-model-'))
const workspace = join(dir, 'ws')
mkdirSync(join(workspace, 'verification', 'results'), { recursive: true })
mkdirSync(join(workspace, 'reports'), { recursive: true })
const RESULTS = join(workspace, 'verification', 'results')
const writeLedger = (name, data) => writeFileSync(join(RESULTS, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf-8')

const taskById = (model, id) => model.phases.flatMap((column) => column.tasks).find((task) => task.id === id)
const columnOf = (model, phase) => model.phases.find((column) => column.phase === phase)

// ── A. 全空 workspace：6 阶段列保留、任务全空、不抛错 ──

const emptyModel = buildBoardModel(workspace, 'p-empty')
assert.equal(emptyModel.phases.length, 6)
assert.deepEqual(emptyModel.phases.map((column) => column.phase), ['REQ_SPEC', 'ARCH', 'RTL', 'VERIF', 'QA', 'SYNTH'])
assert.ok(emptyModel.phases.every((column) => column.tasks.length === 0))
assert.equal(emptyModel.updatedAt, '')

// ── B. 批次账本：verdict→任务状态映射 + 在跑批次 + 列内时间序 ──

writeLedger('verif-batch-loop.json', {
  version: 1,
  updatedAt: '2026-11-12T04:00:01.000Z',
  state: 'running',
  currentBatch: {
    index: 4,
    sessionName: 'phase-verif--batch-4',
    scenarioIds: ['SCN-D'],
    dispatchedAt: '2026-11-12T04:00:00.000Z',
    phase: 'dispatched'
  },
  circuitBreaker: null,
  rtlFixWait: null,
  history: [
    { index: 3, scenarioIds: ['SCN-C'], verdict: 'no-evidence', reason: '会话纯分析，无执行证据', settledAt: '2026-11-12T03:00:00.000Z' },
    {
      index: 1, scenarioIds: ['SCN-A'], verdict: 'completed', reason: '证据齐', settledAt: '2026-11-12T01:00:00.000Z',
      scenarios: [{ id: 'SCN-A', title: '复位释放后 BIST 启动', requirementIds: ['REQ-FUNC-001'] }]
    },
    { index: 2, scenarioIds: ['SCN-B'], verdict: 'circuit-broken', reason: 'watchdog 熔断：诊断停滞', settledAt: '2026-11-12T02:00:00.000Z' }
  ]
})

// ── C. RTL 修复账本：同根因多次修复归一为多次尝试（时间升序），UNKNOWN → no-evidence ──

writeLedger('rtl-fix-outcomes.json', {
  version: 1,
  outcomes: [
    { rootCauseId: 'RC-BBBB0002', scenarioId: 'SCN-Y', fixSessionName: 'phase-verif--fix-RC-BBBB0002', judgment: 'UNKNOWN', reason: '判定证据不足', startedAt: '2026-11-12T03:00:00.000Z', settledAt: '2026-11-12T03:30:00.000Z', auditPath: '', blockedAttempts: 0 },
    { rootCauseId: 'RC-AAAA0001', scenarioId: 'SCN-X', fixSessionName: 'phase-verif--fix-RC-AAAA0001', judgment: 'STILL_FAIL', reason: '仍失败：FAIL 指纹匹配', startedAt: '2026-11-12T02:00:00.000Z', settledAt: '2026-11-12T02:30:00.000Z', auditPath: '', blockedAttempts: 1 },
    { rootCauseId: 'RC-AAAA0001', scenarioId: 'SCN-X', fixSessionName: 'phase-verif--fix-RC-AAAA0001', judgment: 'FIXED', reason: '修复生效', startedAt: '2026-11-12T01:00:00.000Z', settledAt: '2026-11-12T01:30:00.000Z', auditPath: '', blockedAttempts: 0 }
  ]
})

// ── D. 决策账本：proposed 待人 / approved 进行中 / executed 按 outcome 裁决 / rejected 不进看板 ──

const makeDecision = (overrides) => ({
  id: 'DEC-AAAAAAAA',
  createdAt: '2026-11-12T00:00:00.000Z',
  source: 'llm',
  trigger: 'rule-stall',
  action: { kind: 'custom', actionId: null, prompt: '补 checker 后回归', expectedOutput: 'x', stopCriteria: 'y' },
  rationale: '规则空转',
  evidenceRefs: [],
  status: 'proposed',
  outcome: null,
  ...overrides
})
writeLedger('decision-ledger.json', {
  version: 1,
  decisions: [
    makeDecision({ id: 'DEC-PROPOSED1', status: 'proposed', rationale: '待人批准' }),
    makeDecision({ id: 'DEC-APPROVED1', status: 'approved', action: { kind: 'custom', actionId: null, prompt: '已批准的指令', expectedOutput: 'x', stopCriteria: 'y' } }),
    makeDecision({ id: 'DEC-EXECOK001', status: 'executed', outcome: 'advanced' }),
    makeDecision({ id: 'DEC-EXECBAD01', status: 'executed', outcome: 'failed', rationale: '会话异常' }),
    makeDecision({ id: 'DEC-REJECTED1', status: 'rejected' })
  ]
})

// ── E. 模块 UT 账本：按模块归并尝试；completed/active/interrupted 映射 ──

writeLedger('ut-sessions.json', {
  version: 1,
  sessions: [
    { utId: 'UT-00000001', module: 'fifo', sessionName: 'phase-verif--ut-fifo', state: 'completed', startedAt: '2026-11-12T01:00:00.000Z', settledAt: '2026-11-12T01:30:00.000Z' },
    { utId: 'UT-00000002', module: 'fifo', sessionName: 'phase-verif--ut-fifo', state: 'active', startedAt: '2026-11-12T02:00:00.000Z' },
    { utId: 'UT-00000003', module: 'crc', sessionName: 'phase-verif--ut-crc', state: 'interrupted', startedAt: '2026-11-12T03:00:00.000Z', settledAt: '2026-11-12T03:10:00.000Z', note: 'app-restart：锁自动释放' }
  ]
})

// ── F. 设计审查账本：消费带实际用模 / 未消费 running / lastError error / 非法类型跳过 ──

writeFileSync(join(workspace, 'reports', 'review-request.json'), JSON.stringify({
  version: 1,
  requests: [
    {
      type: 'arch-consistency', scope: '复位域 crossing', requestedAt: '2026-11-12T01:00:00.000Z', round: 1,
      consumed: true, consumedAt: '2026-11-12T02:00:00.000Z',
      reviewSession: 'phase-arch--review-arch-consistency', reviewModel: 'deepseek / deepseek-chat'
    },
    { type: 'rtl-semantic', requestedAt: '2026-11-12T03:00:00.000Z', round: 2 },
    { type: 'rtl-semantic', requestedAt: '2026-11-12T04:00:00.000Z', round: 3, lastError: '2026-11-12T04:30:00.000Z：审查会话异常：boom' },
    { type: 'bogus-type', requestedAt: '2026-11-12T05:00:00.000Z', round: 1 }
  ]
}, null, 2), 'utf-8')

// ── G. 运行循环账本：状态映射 + lastBeats/current → 尝试记录 ──

writeLedger('run-loop.json', {
  version: 1,
  updatedAt: '2026-11-12T05:00:00.000Z',
  loopId: 'loop-1',
  state: 'running',
  wave: 'W1',
  beat: 7,
  current: {
    kind: 'run-batch', actionId: 'run-batch', sessionName: 'phase-verif--batch-9',
    dispatchedAt: '2026-11-12T04:50:00.000Z', source: 'rule', decisionId: 'DEC-EXECOK001'
  },
  pause: null,
  budget: { beats: 7, maxBeats: 50, tokensUsed: 100, maxTokens: 5000000, startedAt: '2026-11-12T00:00:00.000Z', maxWallMinutes: 240 },
  lastBeats: [
    { beat: 7, summary: '批次回归有进展', decisionId: 'D7', verdict: 'advanced', advanced: true },
    { beat: 6, summary: 'fix 派发无进展', decisionId: 'D6', verdict: 'no-progress', advanced: false }
  ]
})

const model = buildBoardModel(workspace, 'p-main')

// G1. 阶段列形状：6 阶段固定顺序；ARCH/RTL 只有审查任务；空列保留
assert.deepEqual(model.phases.map((column) => column.phase), ['REQ_SPEC', 'ARCH', 'RTL', 'VERIF', 'QA', 'SYNTH'])
assert.equal(columnOf(model, 'REQ_SPEC').tasks.length, 0)
assert.equal(columnOf(model, 'QA').tasks.length, 0)
assert.equal(columnOf(model, 'SYNTH').tasks.length, 0)
// G2. updatedAt = 各账本 updatedAt 最大值（verif-batch-loop 04:00:01 vs run-loop 05:00:00）
assert.equal(model.updatedAt, '2026-11-12T05:00:00.000Z')

// B1. 批次任务：verdict 映射（completed→success/circuit-broken→needs-fix/no-evidence→pending-human）
const batch1 = taskById(model, 'batch-1')
assert.equal(batch1.kind, 'batch')
assert.equal(batch1.phase, 'VERIF')
assert.equal(batch1.status, 'success')
assert.equal(batch1.title.includes('复位释放后 BIST 启动'), true) // 语义标签快照进标题
assert.equal(batch1.attempts.length, 1)
assert.equal(batch1.attempts[0].verdict, 'success')
assert.equal(batch1.attempts[0].settledAt, '2026-11-12T01:00:00.000Z')
assert.equal(batch1.attempts[0].note, '证据齐')
assert.equal(batch1.attempts[0].index, 1)
const batch2 = taskById(model, 'batch-2')
assert.equal(batch2.status, 'needs-fix')
assert.equal(batch2.attempts[0].verdict, 'circuit-broken')
const batch3 = taskById(model, 'batch-3')
assert.equal(batch3.status, 'pending-human')
assert.equal(batch3.attempts[0].verdict, 'no-evidence')
// B2. 在跑批次：running + 派发时刻
const batch4 = taskById(model, 'batch-4')
assert.equal(batch4.status, 'running')
assert.equal(batch4.attempts[0].verdict, 'running')
assert.equal(batch4.attempts[0].startedAt, '2026-11-12T04:00:00.000Z')
// B3. 列内按最近活动时间新在前：run-loop（04:50）> batch-4（04:00）> … > batch-1（01:00）
const verifTasks = columnOf(model, 'VERIF').tasks
assert.equal(verifTasks[0].id, 'run-loop')
assert.ok(verifTasks.findIndex((task) => task.id === 'batch-4') < verifTasks.findIndex((task) => task.id === 'batch-1'))

// C1. RTL 修复：同根因两次修复归一为一卡两次尝试（时间升序），最近判定 STILL_FAIL → needs-fix
const fixA = taskById(model, 'RC-AAAA0001')
assert.equal(fixA.kind, 'rtl-fix')
assert.equal(fixA.phase, 'VERIF')
assert.equal(fixA.status, 'needs-fix')
assert.equal(fixA.attempts.length, 2)
assert.equal(fixA.attempts[0].index, 1)
assert.equal(fixA.attempts[0].verdict, 'success') // FIXED（先派发）
assert.equal(fixA.attempts[1].index, 2)
assert.equal(fixA.attempts[1].verdict, 'failed') // STILL_FAIL（后派发）
assert.equal(fixA.attempts[1].note, '仍失败：FAIL 指纹匹配')
assert.equal(fixA.title.includes('RC-AAAA0001'), true)
// C2. UNKNOWN → no-evidence → 任务待人
const fixB = taskById(model, 'RC-BBBB0002')
assert.equal(fixB.attempts[0].verdict, 'no-evidence')
assert.equal(fixB.status, 'pending-human')

// D1. 决策：proposed → 待人（无尝试）；approved → 进行中（running 尝试）；executed 按 outcome 裁决
const decProposed = taskById(model, 'DEC-PROPOSED1')
assert.equal(decProposed.kind, 'decision')
assert.equal(decProposed.phase, 'VERIF')
assert.equal(decProposed.status, 'pending-human')
assert.deepEqual(decProposed.attempts, [])
assert.equal(decProposed.title.includes('补 checker 后回归'), true)
const decApproved = taskById(model, 'DEC-APPROVED1')
assert.equal(decApproved.status, 'running')
assert.equal(decApproved.attempts[0].verdict, 'running')
const decOk = taskById(model, 'DEC-EXECOK001')
assert.equal(decOk.status, 'success')
assert.equal(decOk.attempts[0].verdict, 'success')
assert.equal(decOk.attempts[0].note, '规则空转')
const decBad = taskById(model, 'DEC-EXECBAD01')
assert.equal(decBad.status, 'needs-fix')
assert.equal(decBad.attempts[0].verdict, 'error')
// D2. 否决的提案不进看板
assert.equal(taskById(model, 'DEC-REJECTED1'), undefined)

// E1. 模块 UT：按模块归并，completed→success / active→running，最近 active → 任务进行中
const utFifo = taskById(model, 'ut-fifo')
assert.equal(utFifo.kind, 'module-ut')
assert.equal(utFifo.phase, 'VERIF')
assert.equal(utFifo.status, 'running')
assert.equal(utFifo.attempts.length, 2)
assert.equal(utFifo.attempts[0].verdict, 'success')
assert.equal(utFifo.attempts[0].settledAt, '2026-11-12T01:30:00.000Z')
assert.equal(utFifo.attempts[1].verdict, 'running')
// E2. interrupted → error → needs-fix，note 带原因
const utCrc = taskById(model, 'ut-crc')
assert.equal(utCrc.attempts[0].verdict, 'error')
assert.equal(utCrc.status, 'needs-fix')
assert.equal(utCrc.attempts[0].note.includes('app-restart'), true)

// F1. 审查：已消费 → success + 会话实际用模 + 结算时刻；阶段按类型归 ARCH
const reviewArch = taskById(model, 'review-arch-consistency-1')
assert.equal(reviewArch.kind, 'design-review')
assert.equal(reviewArch.phase, 'ARCH')
assert.equal(reviewArch.status, 'success')
assert.equal(reviewArch.attempts[0].model, 'deepseek / deepseek-chat')
assert.equal(reviewArch.attempts[0].verdict, 'success')
assert.equal(reviewArch.attempts[0].startedAt, '2026-11-12T01:00:00.000Z')
assert.equal(reviewArch.attempts[0].settledAt, '2026-11-12T02:00:00.000Z')
assert.equal(reviewArch.attempts[0].note, '复位域 crossing')
// F2. 未消费无错误 → running；阶段归 RTL
const reviewRtl2 = taskById(model, 'review-rtl-semantic-2')
assert.equal(reviewRtl2.phase, 'RTL')
assert.equal(reviewRtl2.status, 'running')
assert.equal(reviewRtl2.attempts[0].verdict, 'running')
assert.equal(reviewRtl2.attempts[0].model, '') // 未消费没有实际用模
// F3. lastError → error → needs-fix，note 带错误
const reviewRtl3 = taskById(model, 'review-rtl-semantic-3')
assert.equal(reviewRtl3.status, 'needs-fix')
assert.equal(reviewRtl3.attempts[0].verdict, 'error')
assert.ok(reviewRtl3.attempts[0].note.includes('审查会话异常'))
// F4. 非法审查类型跳过
assert.equal(taskById(model, 'review-bogus-type-1'), undefined)

// G3. 运行循环：state=running → 任务进行中；lastBeats 时间序还原 + current 为最后尝试
const runLoop = taskById(model, 'run-loop')
assert.equal(runLoop.kind, 'run-loop')
assert.equal(runLoop.phase, 'VERIF')
assert.equal(runLoop.status, 'running')
assert.equal(runLoop.attempts.length, 3) // beat6 + beat7（时间序）+ current
assert.equal(runLoop.attempts[0].verdict, 'failed') // no-progress
assert.equal(runLoop.attempts[0].note, 'fix 派发无进展')
assert.equal(runLoop.attempts[0].startedAt, '') // 账本不记每步时间戳
assert.equal(runLoop.attempts[1].verdict, 'success') // advanced
assert.equal(runLoop.attempts[2].verdict, 'running') // current
assert.equal(runLoop.attempts[2].startedAt, '2026-11-12T04:50:00.000Z')
assert.ok(runLoop.attempts[2].note.includes('run-batch'))

// ── H. 坏 JSON 降级：单账本损坏只影响对应来源，整体不抛错 ──

writeLedger('decision-ledger.json', 'not-json{{{')
writeLedger('ut-sessions.json', '<<<corrupted>>>')
const degraded = buildBoardModel(workspace, 'p-main')
assert.equal(taskById(degraded, 'DEC-PROPOSED1'), undefined) // 决策来源降级为空
assert.equal(taskById(degraded, 'ut-fifo'), undefined) // UT 来源降级为空
assert.equal(taskById(degraded, 'batch-1') !== undefined, true) // 其余来源不受影响
assert.equal(taskById(degraded, 'RC-AAAA0001') !== undefined, true)
assert.equal(taskById(degraded, 'review-arch-consistency-1') !== undefined, true)
assert.equal(taskById(degraded, 'run-loop') !== undefined, true)
// 账本整体缺失：全部降级、updatedAt 回落到剩余账本的最大值（rtl-fix 与 review-request 无 updatedAt 字段 → 空串）
writeLedger('verif-batch-loop.json', JSON.stringify(null)) // 顶层 null：归一为无账本
writeLedger('run-loop.json', '')
const emptied = buildBoardModel(workspace, 'p-main')
// VERIF 列只剩 rtl-fix 两卡（未损坏来源不受影响）；决策/UT/批次/运行循环全部降级为空
assert.equal(columnOf(emptied, 'VERIF').tasks.length, 2)
assert.equal(emptied.updatedAt, '')

// ── I. 会话名前缀阶段归属：批次会话名归 RTL 列；无前缀会话名回退 VERIF ──

const dir2 = mkdtempSync(join(tmpdir(), 'moonglass-board-model-phase-'))
const workspace2 = join(dir2, 'ws')
mkdirSync(join(workspace2, 'verification', 'results'), { recursive: true })
writeFileSync(join(workspace2, 'verification', 'results', 'verif-batch-loop.json'), JSON.stringify({
  version: 1,
  updatedAt: '2026-11-12T06:00:00.000Z',
  state: 'running',
  currentBatch: { index: 9, sessionName: 'phase-rtl--batch-9', scenarioIds: ['SCN-Z'], dispatchedAt: '2026-11-12T06:00:00.000Z', phase: 'dispatched' },
  circuitBreaker: null,
  rtlFixWait: null,
  history: []
}, null, 2), 'utf-8')
writeFileSync(join(workspace2, 'verification', 'results', 'ut-sessions.json'), JSON.stringify({
  version: 1,
  sessions: [
    { utId: 'UT-FFFFFF01', module: 'top', sessionName: 'no-phase-prefix', state: 'active', startedAt: '2026-11-12T06:10:00.000Z' }
  ]
}, null, 2), 'utf-8')
const phaseModel = buildBoardModel(workspace2, 'p-phase')
assert.equal(taskById(phaseModel, 'batch-9').phase, 'RTL') // phase-rtl--batch-9 → RTL 列
assert.equal(columnOf(phaseModel, 'RTL').tasks.length, 1)
assert.equal(taskById(phaseModel, 'ut-top').phase, 'VERIF') // 无前缀回退默认阶段

console.log('board-model-smoke: OK（6 阶段列/任务类型六类映射/状态五类映射/尝试记录（模型·判定·起止·note）/坏 JSON 降级/前缀阶段归属与回退/列内时间序/updatedAt 取最大值）')
