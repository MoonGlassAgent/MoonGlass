// 失败诊断与修复可视化方案 C 批 1（设计文档 §3.1/§3.2）：
// 批次循环状态文件（覆盖式）的状态转换（dispatched→completed / circuit-broken / stopped /
// awaiting-rtl-fix）与 history 滚动上限；修复判定账本（追加式）的三判定落盘与 50 条上限。
// 直接转译 src/main/services/verif-loop-ledger.ts 与 rtl-fix-outcome-ledger.ts 测试
// （与 verif-batch-verdict-smoke 同模式）。
import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'moonglass-verif-loop-ledger-'))
const compile = (sourcePath, outfile) => {
  const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  })
  const path = join(dir, outfile)
  writeFileSync(path, compiled.outputText, 'utf8')
  return pathToFileURL(path).href
}
const { readVerifLoopLedger, updateVerifLoopLedger, VERIF_LOOP_HISTORY_LIMIT } = await import(compile('src/main/services/verif-loop-ledger.ts', 'verif-loop-ledger.mjs'))
const { readRtlFixOutcomeLedger, appendRtlFixOutcome, RTL_FIX_OUTCOME_LIMIT } = await import(compile('src/main/services/rtl-fix-outcome-ledger.ts', 'rtl-fix-outcome-ledger.mjs'))

const workspace = join(dir, 'ws')
mkdirSync(workspace, { recursive: true })
const readLoopFile = () => JSON.parse(readFileSync(join(workspace, 'verification', 'results', 'verif-batch-loop.json'), 'utf-8'))
const readOutcomeFile = () => JSON.parse(readFileSync(join(workspace, 'verification', 'results', 'rtl-fix-outcomes.json'), 'utf-8'))

// ── A. 批次循环状态文件（§3.2，覆盖式）──

// A1. 无文件时 read 返回 null（调用方按无循环记录处理，不造文件）
assert.equal(readVerifLoopLedger(workspace), null)

// A2. 循环开始：重置为 running（覆盖上次循环终态），version/updatedAt 齐全
updateVerifLoopLedger(workspace, (l) => { l.state = 'running'; l.currentBatch = null; l.circuitBreaker = null; l.rtlFixWait = null; l.history = [] })
let file = readLoopFile()
assert.equal(file.version, 1)
assert.equal(file.state, 'running')
assert.ok(typeof file.updatedAt === 'string' && file.updatedAt.length > 0)
assert.deepEqual(file.history, [])

// A3. 批次派发 → running + currentBatch(dispatched)
updateVerifLoopLedger(workspace, (l) => { l.state = 'running'; l.currentBatch = { index: 1, sessionName: 'phase-verif--batch-1', scenarioIds: ['SCN-AAAAAAAA'], dispatchedAt: new Date().toISOString(), phase: 'dispatched' } })
file = readLoopFile()
assert.equal(file.currentBatch.phase, 'dispatched')
assert.equal(file.currentBatch.index, 1)
assert.deepEqual(file.currentBatch.scenarioIds, ['SCN-AAAAAAAA'])

// A4. 批次会话结束、完成判定进行中 → settling
updateVerifLoopLedger(workspace, (l) => { if (l.currentBatch) l.currentBatch.phase = 'settling' })
assert.equal(readLoopFile().currentBatch.phase, 'settling')

// A5. 批次收尾：history 追加 + completed 终态（dispatched→completed 全链路）
updateVerifLoopLedger(workspace, (l) => {
  l.currentBatch = null
  l.history.unshift({ index: 1, scenarioIds: ['SCN-AAAAAAAA'], verdict: 'completed', reason: '证据齐全：scenario_hits 已登记且 posture 已重建', settledAt: new Date().toISOString() })
  l.state = 'completed'
})
file = readLoopFile()
assert.equal(file.state, 'completed')
assert.equal(file.currentBatch, null)
assert.equal(file.history.length, 1)
assert.equal(file.history[0].verdict, 'completed')
assert.ok(file.history[0].reason.includes('scenario_hits'))

// A6. awaiting-rtl-fix（等修复暂停带 rootCauseId/since）→ 修复 settle 后恢复 running
updateVerifLoopLedger(workspace, (l) => { l.state = 'awaiting-rtl-fix'; l.currentBatch = null; l.rtlFixWait = { rootCauseId: 'RC-DEADBEEF', since: new Date().toISOString() } })
file = readLoopFile()
assert.equal(file.state, 'awaiting-rtl-fix')
assert.equal(file.rtlFixWait.rootCauseId, 'RC-DEADBEEF')
updateVerifLoopLedger(workspace, (l) => { l.state = 'running'; l.rtlFixWait = null })
file = readLoopFile()
assert.equal(file.state, 'running')
assert.equal(file.rtlFixWait, null)

// A7. circuit-broken 终态带结构化熔断原因（缺哪个 scenario 登记写入 reason）
updateVerifLoopLedger(workspace, (l) => {
  l.state = 'circuit-broken'
  l.currentBatch = null
  l.circuitBreaker = { reason: '证据缺失：场景未登记 scenario_hits：SCN-BBBBBBBB', detail: '批次 phase-verif--batch-2 未正常完成，已停止后续批次' }
  l.history.unshift({ index: 2, scenarioIds: ['SCN-BBBBBBBB'], verdict: 'circuit-broken', reason: '证据缺失：场景未登记 scenario_hits：SCN-BBBBBBBB', settledAt: new Date().toISOString() })
})
file = readLoopFile()
assert.equal(file.state, 'circuit-broken')
assert.ok(file.circuitBreaker.reason.includes('SCN-BBBBBBBB'))
assert.equal(file.history[0].verdict, 'circuit-broken')

// A8. stopped 终态：清空当前批/熔断/等待，history 保留供 UI 展示
updateVerifLoopLedger(workspace, (l) => { l.currentBatch = { index: 3, sessionName: 'phase-verif--batch-3', scenarioIds: ['SCN-CCCCCCCC'], dispatchedAt: new Date().toISOString(), phase: 'dispatched' } })
updateVerifLoopLedger(workspace, (l) => { l.state = 'stopped'; l.currentBatch = null; l.rtlFixWait = null; l.circuitBreaker = null })
file = readLoopFile()
assert.equal(file.state, 'stopped')
assert.equal(file.currentBatch, null)
assert.equal(file.circuitBreaker, null)
assert.equal(file.history.length, 2)

// A9. history 滚动上限：unshift 25 条 → 截断到 20 条且最新在前
updateVerifLoopLedger(workspace, (l) => {
  l.history = []
  for (let index = 0; index < 25; index += 1) l.history.unshift({ index, scenarioIds: [`SCN-${String(index).padStart(8, '0')}`], verdict: 'completed', reason: `批次 ${index}`, settledAt: new Date().toISOString() })
})
file = readLoopFile()
assert.equal(VERIF_LOOP_HISTORY_LIMIT, 20)
assert.equal(file.history.length, 20)
assert.equal(file.history[0].index, 24)

// A10. 损坏文件：read 返回 null；update 从 idle 初值重建
writeFileSync(join(workspace, 'verification', 'results', 'verif-batch-loop.json'), '{broken json', 'utf-8')
assert.equal(readVerifLoopLedger(workspace), null)
updateVerifLoopLedger(workspace, (l) => { l.state = 'running' })
assert.equal(readLoopFile().state, 'running')

// A11. 缺字段/未知值归一：未知 state 归一为 idle，非法 history 归一为空数组
writeFileSync(join(workspace, 'verification', 'results', 'verif-batch-loop.json'), JSON.stringify({ state: 'bogus-state', history: 'not-an-array' }), 'utf-8')
const normalized = readVerifLoopLedger(workspace)
assert.equal(normalized.state, 'idle')
assert.deepEqual(normalized.history, [])
assert.equal(normalized.currentBatch, null)
assert.equal(normalized.circuitBreaker, null)

// ── B. 修复判定账本（§3.1，追加式）──

const record = (suffix, judgment) => ({
  rootCauseId: `RC-${suffix}`,
  scenarioId: `SCN-${suffix}`,
  fixSessionName: `phase-verif--fix-RC-${suffix}`,
  judgment,
  reason: `判定依据 ${suffix}`,
  startedAt: '2026-09-29T01:00:00.000Z',
  settledAt: '2026-09-29T02:00:00.000Z',
  auditPath: `verification/results/rtl-fix-audit-RC-${suffix}.json`,
  blockedAttempts: 2
})

// B1. FIXED/STILL_FAIL/UNKNOWN 三判定落盘；unshift 最新在前；字段齐全
appendRtlFixOutcome(workspace, record('00000001', 'FIXED'))
appendRtlFixOutcome(workspace, record('00000002', 'STILL_FAIL'))
appendRtlFixOutcome(workspace, record('00000003', 'UNKNOWN'))
let outcomes = readOutcomeFile()
assert.equal(outcomes.version, 1)
assert.equal(outcomes.outcomes.length, 3)
assert.deepEqual(outcomes.outcomes.map((item) => item.judgment), ['UNKNOWN', 'STILL_FAIL', 'FIXED'])
const fixed = outcomes.outcomes[2]
assert.equal(fixed.rootCauseId, 'RC-00000001')
assert.equal(fixed.scenarioId, 'SCN-00000001')
assert.equal(fixed.fixSessionName, 'phase-verif--fix-RC-00000001')
assert.equal(fixed.auditPath, 'verification/results/rtl-fix-audit-RC-00000001.json')
assert.equal(fixed.blockedAttempts, 2)
assert.ok(fixed.startedAt < fixed.settledAt)

// B2. 50 条上限：再追加 60 条 → 恰好 50 条且最新在前
for (let index = 0; index < 60; index += 1) appendRtlFixOutcome(workspace, record(`F${String(index).padStart(7, '0')}`, 'FIXED'))
outcomes = readOutcomeFile()
assert.equal(RTL_FIX_OUTCOME_LIMIT, 50)
assert.equal(outcomes.outcomes.length, 50)
assert.equal(outcomes.outcomes[0].rootCauseId, `RC-F${String(59).padStart(7, '0')}`)

// B3. 损坏文件按空账本处理，可继续追加
writeFileSync(join(workspace, 'verification', 'results', 'rtl-fix-outcomes.json'), 'not json at all', 'utf-8')
assert.deepEqual(readRtlFixOutcomeLedger(workspace), { version: 1, outcomes: [] })
appendRtlFixOutcome(workspace, record('00000009', 'UNKNOWN'))
outcomes = readOutcomeFile()
assert.equal(outcomes.outcomes.length, 1)
assert.equal(outcomes.outcomes[0].judgment, 'UNKNOWN')

console.log('verif-loop-ledger-smoke: OK（批次循环 dispatched→completed/circuit-broken/stopped/awaiting-rtl-fix + history≤20；修复账本三判定落盘 + ≤50 条 + 容错）')
