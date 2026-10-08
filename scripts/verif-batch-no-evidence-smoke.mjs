// 4b 无执行批次合法出口 + decide 批准墙钟开窗 + 批次循环账本 deferred 归一
// （三重闩锁之二实测：批次会话正常结束但未跑 run_simulation → 旧口径判"证据缺失"熔断 →
//   下轮再选同样场景 → 永不自解；decide 实测：墙钟 253/240 时批准合规提案被系统性误杀）
// 与 decision-ledger-smoke 同模式：node:module 注册别名钩子后动态 import TS 源码纯函数。
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const { judgeBatchBreakers } = await import('../src/main/services/verif-batch-verdict.ts')
const { createRunLoopLedger, applyRunLoopPause, resolveRunLoopStartOptions, resumeRunLoopWallWindow, resetRunLoopBudgetWindow } = await import('../src/main/services/verif-run-loop.ts')
const { validateDecisionForApproval, isBudgetExceededRejection } = await import('../src/main/services/decision-ledger.ts')
const { readVerifLoopLedger, updateVerifLoopLedger, verifLoopLedgerPath } = await import('../src/main/services/verif-loop-ledger.ts')

const dir = mkdtempSync(join(tmpdir(), 'moonglass-verif-no-evidence-'))
const workspace = join(dir, 'ws')
mkdirSync(join(workspace, 'verification', 'results'), { recursive: true })

// ── A. judgeBatchBreakers：no-evidence 判空路径（正常 settle + 证据缺失 → 合法出口）──

const baseInput = {
  evidenceComplete: false,
  evidenceReasons: ['场景未登记 scenario_hits：SCN-AAAAAAAA', 'verification-posture.json 不存在或不可解析'],
  errorMessage: null,
  transientSessionError: false,
  watchdogAbort: null,
  userStopped: false,
  diagnosticStalled: false
}

// A1. 会话正常 settle（无异常/watchdog/用户停止/诊断停滞）且证据缺失 → no-evidence，不熔断
const noEvidence = judgeBatchBreakers(baseInput)
assert.equal(noEvidence.status, 'no-evidence')
assert.equal(noEvidence.circuitBreaker, null)

// A2. 会话异常（含瞬时故障）→ 维持熔断，errorMessage 留给 runVerifBatches 自动重试
const withError = judgeBatchBreakers({ ...baseInput, errorMessage: '[pi-rpc] 等待 Agent 事件超时', transientSessionError: true })
assert.equal(withError.status, 'circuit-broken')
assert.ok(withError.circuitBreaker.includes('批次会话异常'))

// A3. watchdog / 用户停止 / 诊断停滞 → 维持熔断（合法出口只豁免"会话正常结束"组合）
assert.equal(judgeBatchBreakers({ ...baseInput, watchdogAbort: 'Agent 运行超过 10 分钟无工具调用' }).status, 'circuit-broken')
assert.equal(judgeBatchBreakers({ ...baseInput, userStopped: true }).status, 'circuit-broken')
assert.equal(judgeBatchBreakers({ ...baseInput, diagnosticStalled: true }).status, 'circuit-broken')
// 证据缺失 + 会话异常同时存在 → 熔断原因同时包含两条（口径与历史实现一致）
const both = judgeBatchBreakers({ ...baseInput, errorMessage: 'socket hang up' })
assert.ok(both.circuitBreaker.includes('批次会话异常') && both.circuitBreaker.includes('证据缺失'))

// A4. 证据齐 → completed；证据齐 + 尾随瞬时故障 → 仍 completed（证据优先，不推翻）
assert.equal(judgeBatchBreakers({ ...baseInput, evidenceComplete: true, evidenceReasons: [] }).status, 'completed')
const trailing = judgeBatchBreakers({ ...baseInput, evidenceComplete: true, evidenceReasons: [], errorMessage: 'Provider returned an empty response', transientSessionError: true })
assert.equal(trailing.status, 'completed')
assert.equal(trailing.circuitBreaker, null)

// ── B. decide 批准时的墙钟开窗口径（AgentService.decideVerifRunDecision 校验路径复刻）──

/** 合规的 custom 类决策（字段口径与 decision-ledger-smoke 一致） */
const makeDecision = () => ({
  id: 'DEC-AAAAAAAA',
  createdAt: '2026-10-05T00:00:00.000Z',
  source: 'llm',
  trigger: 'rule-stall',
  action: { kind: 'custom', actionId: null, prompt: '读取失败日志并归因', expectedOutput: '根因假设登记到 root-causes.json', stopCriteria: '登记完成或证据不足说明' },
  rationale: '规则空转，需要人工方向的替代排查路径',
  evidenceRefs: [],
  status: 'proposed',
  outcome: null
})

// B0. 等待不计费：暂停把活跃段滚入 wallResetBase 冻结窗口；恢复直接开新窗，等待段不进任何维度
const pausedLedger = createRunLoopLedger(resolveRunLoopStartOptions({ maxWallMinutes: 240 }), '2026-10-05T00:00:00.000Z', true)
applyRunLoopPause(pausedLedger, { kind: 'human', reason: 'llm-decision-pending', detail: 'd', pendingItems: [], since: '2026-10-05T04:13:00.000Z' })
assert.equal(pausedLedger.budget.wallResetBase, 253, '活跃段 253 分钟滚入 wallResetBase')
assert.equal(pausedLedger.budget.startedAt, '2026-10-05T04:13:00.000Z', '窗口冻结在暂停点')
resumeRunLoopWallWindow(pausedLedger, '2026-10-05T12:00:00.000Z')
assert.equal(pausedLedger.budget.startedAt, '2026-10-05T12:00:00.000Z', '恢复直接开新窗')
assert.equal(pausedLedger.budget.wallResetBase, 253, '等待段（约 8 小时）不重复计入 base')

// B1. 墙钟超限（实测 253/240）：真实预算 → 拒绝；decide 批准候选（resetRunLoopBudgetWindow 三维归零开新窗）→ 通过
const startedAt = '2026-10-05T00:00:00.000Z'
const overWallNow = new Date(Date.parse(startedAt) + 253 * 60_000).toISOString()
const ledger = createRunLoopLedger(resolveRunLoopStartOptions({ maxWallMinutes: 240 }), startedAt, true)
const wallRejected = validateDecisionForApproval(makeDecision(), ledger.budget, overWallNow)
assert.equal(wallRejected.ok, false)
assert.ok(wallRejected.reason.includes('墙钟预算已超限'))
// decide 批准分支的候选口径：克隆账本 + resetRunLoopBudgetWindow（人工值守手势三维归零，与 resumeVerifRunLoop source='user' 同权）
const candidateLoop = JSON.parse(JSON.stringify(ledger))
resetRunLoopBudgetWindow(candidateLoop, overWallNow)
assert.equal(candidateLoop.budget.startedAt, overWallNow, '批准手势即开新窗')
assert.equal(candidateLoop.budget.wallResetBase, 0, 'decide 候选不累计等待段（仅校验用，丢弃）')
const wallApproved = validateDecisionForApproval(makeDecision(), candidateLoop.budget, overWallNow)
assert.equal(wallApproved.ok, true, '批准是人工值守手势：预算维度归零开新窗后合规提案不得被误杀')

// B2. 步数预算超限（实测 token/步数超限态批准被拦）：真实预算 → 拒绝；人工值守候选三维归零 → 通过
const beatsLedger = createRunLoopLedger(resolveRunLoopStartOptions({ maxWallMinutes: 240, maxBeats: 5 }), startedAt, true)
beatsLedger.budget.beats = 5
const beatsRejected = validateDecisionForApproval(makeDecision(), beatsLedger.budget, overWallNow)
assert.equal(beatsRejected.ok, false)
assert.ok(beatsRejected.reason.includes('循环步数预算已超限'))
const beatsCandidate = JSON.parse(JSON.stringify(beatsLedger))
resetRunLoopBudgetWindow(beatsCandidate, overWallNow)
assert.equal(beatsCandidate.budget.beats, 0, '人工值守手势步数归零')
assert.equal(validateDecisionForApproval(makeDecision(), beatsCandidate.budget, overWallNow).ok, true)

// B3. token 预算超限：真实预算 → 拒绝；人工值守候选三维归零 → 通过
const tokensLedger = createRunLoopLedger(resolveRunLoopStartOptions({ maxWallMinutes: 240, maxTokens: 1000 }), startedAt, true)
tokensLedger.budget.tokensUsed = 1000
const tokensRejected = validateDecisionForApproval(makeDecision(), tokensLedger.budget, overWallNow)
assert.equal(tokensRejected.ok, false)
assert.ok(tokensRejected.reason.includes('token 预算已超限'))
const tokensCandidate = JSON.parse(JSON.stringify(tokensLedger))
resetRunLoopBudgetWindow(tokensCandidate, overWallNow)
assert.equal(tokensCandidate.budget.tokensUsed, 0, '人工值守手势 token 归零')
assert.equal(validateDecisionForApproval(makeDecision(), tokensCandidate.budget, overWallNow).ok, true)

// B4. 环境类 vs 结构类校验失败分类（decide 分支据此决定记不记 rejected）：
//     预算超限=环境类（提案保持待裁决可重试）；结构类失败=终结提案
assert.equal(isBudgetExceededRejection(wallRejected.reason), true, '墙钟超限属环境类')
assert.equal(isBudgetExceededRejection(beatsRejected.reason), true, '步数超限属环境类')
assert.equal(isBudgetExceededRejection(tokensRejected.reason), true, 'token 超限属环境类')
const structuralDecision = makeDecision()
structuralDecision.action = { ...structuralDecision.action, stopCriteria: '' }
const structural = validateDecisionForApproval(structuralDecision, ledger.budget, overWallNow)
assert.equal(structural.ok, false)
assert.equal(isBudgetExceededRejection(structural.reason), false, '结构类失败才终结提案')

// ── C. verif-batch-loop.json：deferredScenarioIds 归一 + history 'no-evidence' verdict ──

// C1. no-evidence 批次收尾：history verdict 记 'no-evidence'（新值合法往返）
updateVerifLoopLedger(workspace, (l) => {
  l.state = 'running'
  l.history.unshift({ index: 1, scenarioIds: ['SCN-AAAAAAAA', 'SCN-BBBBBBBB'], verdict: 'no-evidence', reason: '无执行证据（会话正常结束，场景可能无需执行）：posture 未重建', settledAt: '2026-10-05T01:00:00.000Z' })
})
let loop = readVerifLoopLedger(workspace)
assert.equal(loop.history[0].verdict, 'no-evidence')

// C2. deferred 累积（runVerifBatches no-evidence 分支口径）：大写去重追加
updateVerifLoopLedger(workspace, (l) => {
  const existing = new Set(l.deferredScenarioIds ?? [])
  for (const id of ['SCN-AAAAAAAA', 'SCN-BBBBBBBB']) existing.add(id.toUpperCase())
  l.deferredScenarioIds = [...existing]
})
updateVerifLoopLedger(workspace, (l) => {
  const existing = new Set(l.deferredScenarioIds ?? [])
  for (const id of ['SCN-AAAAAAAA', 'SCN-CCCCCCCC']) existing.add(id.toUpperCase())
  l.deferredScenarioIds = [...existing]
})
loop = readVerifLoopLedger(workspace)
assert.deepEqual(loop.deferredScenarioIds, ['SCN-AAAAAAAA', 'SCN-BBBBBBBB', 'SCN-CCCCCCCC'], 'deferred 累积去重')

// C3. 本轮不再选中：选批结果按 deferred 过滤（runVerifBatches 选批过滤口径）
const deferredSet = new Set((readVerifLoopLedger(workspace)?.deferredScenarioIds ?? []).map((id) => id.toUpperCase()))
const selected = ['SCN-AAAAAAAA', 'SCN-CCCCCCCC', 'SCN-DDDDDDDD']
assert.deepEqual(selected.filter((id) => !deferredSet.has(id.trim().toUpperCase())), ['SCN-DDDDDDDD'], '已延后场景本循环内不再选中')
const allDeferred = ['SCN-AAAAAAAA', 'SCN-CCCCCCCC']
assert.equal(allDeferred.filter((id) => !deferredSet.has(id.trim().toUpperCase())).length, 0, '全部待执行场景均已延后 → 空批走 exhausted 出口结束循环')

// C4. 新循环开始（running 重置）清空 deferred：下次循环这些场景重新参与选批
updateVerifLoopLedger(workspace, (l) => {
  l.state = 'running'
  l.deferredScenarioIds = []
})
assert.equal(readVerifLoopLedger(workspace).deferredScenarioIds, undefined, '空数组归一为 undefined（旧账本同口径）')

// C5. 旧账本兼容：无 deferredScenarioIds 字段 → undefined；未知 history verdict → circuit-broken
writeFileSync(verifLoopLedgerPath(workspace), JSON.stringify({
  state: 'running',
  currentBatch: null,
  history: [
    { index: 1, scenarioIds: ['SCN-X'], verdict: 'no-evidence', reason: '', settledAt: '' },
    { index: 2, scenarioIds: ['SCN-Y'], verdict: 'bogus', reason: '', settledAt: '' }
  ]
}), 'utf-8')
const legacy = readVerifLoopLedger(workspace)
assert.equal(legacy.deferredScenarioIds, undefined)
assert.equal(legacy.history[0].verdict, 'no-evidence')
assert.equal(legacy.history[1].verdict, 'circuit-broken', '未知 verdict 归一回熔断类（渲染端旧归一兼容）')
// 非数组 deferred 归一为 undefined
writeFileSync(verifLoopLedgerPath(workspace), JSON.stringify({ state: 'running', deferredScenarioIds: 'SCN-Z' }), 'utf-8')
assert.equal(readVerifLoopLedger(workspace).deferredScenarioIds, undefined)

console.log('verif-batch-no-evidence-smoke: OK（no-evidence 判空路径 + deferred 累积/过滤/重置/归一 + decide 人工值守手势三维预算归零开窗豁免）')
