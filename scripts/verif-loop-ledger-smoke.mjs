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
const { readVerifLoopLedger, updateVerifLoopLedger, readScenarioLabels, VERIF_LOOP_HISTORY_LIMIT, VERIF_SCENARIO_TITLE_MAX } = await import(compile('src/main/services/verif-loop-ledger.ts', 'verif-loop-ledger.mjs'))
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

// A9. history 滚动上限：unshift 25 条 completed → 截断到 20 条且最新在前
updateVerifLoopLedger(workspace, (l) => {
  l.history = []
  for (let index = 0; index < 25; index += 1) l.history.unshift({ index, scenarioIds: [`SCN-${String(index).padStart(8, '0')}`], verdict: 'completed', reason: `批次 ${index}`, settledAt: new Date().toISOString() })
})
file = readLoopFile()
assert.equal(VERIF_LOOP_HISTORY_LIMIT, 20)
assert.equal(file.history.length, 20)
assert.equal(file.history[0].index, 24)

// A9b. 裁剪只作用于 completed（BUG-VERIF-BATCH-001 R4）：早期 no-evidence / circuit-broken
//      结算审计价值最高（用户报告：发现真实门禁失败的第 25 批以 no-evidence 结算，被滚动
//      窗口裁剪后审计断链），永久保留不裁；completed 仍受 20 条上限约束
updateVerifLoopLedger(workspace, (l) => {
  l.history = []
  for (let index = 0; index < 25; index += 1) l.history.unshift({ index, scenarioIds: [`SCN-C${String(index).padStart(7, '0')}`], verdict: 'completed', reason: `批次 ${index}`, settledAt: new Date().toISOString() })
  l.history.push(
    { index: 90, scenarioIds: ['SCN-OLDNOEV1'], verdict: 'no-evidence', reason: '无执行证据：静态通道缺口', settledAt: '2026-10-08T11:04:58.096Z' },
    { index: 91, scenarioIds: ['SCN-OLDBREK1'], verdict: 'circuit-broken', reason: '证据缺失：场景未登记 scenario_hits：SCN-OLDBREK1', settledAt: '2026-10-08T10:00:00.000Z' }
  )
})
file = readLoopFile()
assert.equal(file.history.filter((entry) => entry.verdict === 'completed').length, 20, 'completed 仍受 20 条滚动上限约束')
assert.equal(file.history.length, 22, '非成功结算不计入滚动窗口、永久保留')
assert.ok(file.history.some((entry) => entry.index === 90 && entry.verdict === 'no-evidence'), '早期 no-evidence 结算不被裁剪')
assert.ok(file.history.some((entry) => entry.index === 91 && entry.verdict === 'circuit-broken'), '早期熔断结算不被裁剪')

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

// A12-A15. 场景语义标签快照（可读性，2026-10-05）：批次里"在验证什么"随账本落盘，
//          历史批次不依赖当前注册表；取不到标签一律降级，绝不因此让派发失败。
mkdirSync(join(workspace, 'verification', 'intelligence'), { recursive: true })
writeFileSync(join(workspace, 'verification', 'intelligence', 'scenario-registry.json'), JSON.stringify({
  scenarios: [
    { id: 'SCN-AAAAAAAA', title: '基础功能（REQ-FUNC-002#d）：相邻帧间隔 ≥ 96 bit time', requirementIds: ['REQ-FUNC-002#d'] },
    { id: 'SCN-BBBBBBBB', title: '', requirementIds: [] }
  ]
}), 'utf-8')

// A12. 按 ID 取标签；标题为空的场景仍返回条目（界面显示"无标题快照"，不静默隐藏）
const labels = readScenarioLabels(workspace, ['SCN-AAAAAAAA', 'SCN-BBBBBBBB', 'SCN-MISSING1'])
assert.deepEqual(labels.map((label) => label.id), ['SCN-AAAAAAAA', 'SCN-BBBBBBBB', 'SCN-MISSING1'])
assert.ok(labels[0].title.includes('相邻帧间隔'))
assert.deepEqual(labels[0].requirementIds, ['REQ-FUNC-002#d'])
assert.equal(labels[1].title, '')
assert.equal(labels[2].title, '', 'ID 未命中返回空标题而不是抛错')
assert.deepEqual(labels[2].requirementIds, [])

// A13. 注册表缺失（新工程/未生成态势）不抛错，全部降级为空标题
const emptyWorkspace = join(dir, 'ws-no-registry')
mkdirSync(emptyWorkspace, { recursive: true })
assert.deepEqual(readScenarioLabels(emptyWorkspace, ['SCN-AAAAAAAA']), [{ id: 'SCN-AAAAAAAA', title: '', requirementIds: [] }])

// A14. 账本往返保留快照：currentBatch 写入 → 收尾搬进 history（沿用派发时那一份）
updateVerifLoopLedger(workspace, (l) => {
  l.currentBatch = { index: 9, sessionName: 'phase-verif--batch-9', scenarioIds: ['SCN-AAAAAAAA'], dispatchedAt: new Date().toISOString(), phase: 'dispatched', scenarios: [labels[0]] }
})
assert.equal(readVerifLoopLedger(workspace).currentBatch.scenarios[0].id, 'SCN-AAAAAAAA')
updateVerifLoopLedger(workspace, (l) => {
  l.history.unshift({ index: 9, scenarioIds: ['SCN-AAAAAAAA'], verdict: 'completed', reason: '证据齐全', settledAt: new Date().toISOString(), scenarios: l.currentBatch.scenarios })
  l.currentBatch = null
})
assert.ok(readVerifLoopLedger(workspace).history[0].scenarios[0].title.includes('相邻帧间隔'))

// A15. 旧账本（无 scenarios 字段）归一为 undefined，不产生空数组噪声；超长标题截断
const loopPath = join(workspace, 'verification', 'results', 'verif-batch-loop.json')
writeFileSync(loopPath, JSON.stringify({
  state: 'running',
  currentBatch: { index: 1, sessionName: 's', scenarioIds: ['SCN-X'], dispatchedAt: '', phase: 'dispatched' },
  history: [{ index: 1, scenarioIds: ['SCN-X'], verdict: 'completed', reason: '', settledAt: '' }]
}), 'utf-8')
const legacy = readVerifLoopLedger(workspace)
assert.equal(legacy.currentBatch.scenarios, undefined)
assert.equal(legacy.history[0].scenarios, undefined)
writeFileSync(loopPath, JSON.stringify({
  state: 'running',
  currentBatch: { index: 1, sessionName: 's', scenarioIds: ['SCN-X'], dispatchedAt: '', phase: 'dispatched', scenarios: [{ id: 'SCN-X', title: 'x'.repeat(500), requirementIds: [] }] }
}), 'utf-8')
assert.equal(readVerifLoopLedger(workspace).currentBatch.scenarios[0].title.length, VERIF_SCENARIO_TITLE_MAX)

// A16-A18. deferredScenarioIds 结构化 + 旧账本兼容 + 自动退役（BUG-VERIF-BATCH-001 C3）

// A16. 对象结构写入 → 读取往返保留元数据（scenarioId/deferredAt/reason/batchIndex）
updateVerifLoopLedger(workspace, (l) => {
  l.deferredScenarioIds = [
    { scenarioId: 'SCN-AAAAAAAA', deferredAt: '2026-10-08T11:04:58.096Z', reason: '无执行证据：该批为静态通道场景（缺口改造中）', batchIndex: 25 },
    { scenarioId: 'SCN-BBBBBBBB', deferredAt: '2026-10-08T12:00:00.000Z', reason: '无执行证据：场景可能漏跑', batchIndex: 26 }
  ]
})
file = readLoopFile()
assert.equal(file.deferredScenarioIds.length, 2)
assert.deepEqual(file.deferredScenarioIds[0], {
  scenarioId: 'SCN-AAAAAAAA',
  deferredAt: '2026-10-08T11:04:58.096Z',
  reason: '无执行证据：该批为静态通道场景（缺口改造中）',
  batchIndex: 25
}, 'deferred 条目为对象结构，元数据齐全可审计')

// A17. 旧账本裸 string[] 归一：缺省元数据（deferredAt/reason 空、batchIndex null）、大写去重
writeFileSync(loopPath, JSON.stringify({ state: 'running', deferredScenarioIds: ['SCN-aaaaaaaa', 'SCN-BBBBBBBB', 'SCN-aaaaaaaa', '', 42] }), 'utf-8')
assert.deepEqual(readVerifLoopLedger(workspace).deferredScenarioIds, [
  { scenarioId: 'SCN-AAAAAAAA', deferredAt: '', reason: '', batchIndex: null },
  { scenarioId: 'SCN-BBBBBBBB', deferredAt: '', reason: '', batchIndex: null }
], '裸字符串归一为对象（元数据缺省空），非法条目丢弃')

// A18. 自动退役：注册表 status=VERIFIED/WAIVED 的场景在读取归一与写入时均删除
//      （场景已闭环，defer 语义失效；不退役会导致重复派发/配额浪费或永久跳过）
writeFileSync(join(workspace, 'verification', 'intelligence', 'scenario-registry.json'), JSON.stringify({
  scenarios: [
    { id: 'SCN-AAAAAAAA', title: '已闭环', status: 'VERIFIED', method: 'static' },
    { id: 'SCN-BBBBBBBB', title: '已豁免', status: 'WAIVED', method: 'simulation' },
    { id: 'SCN-CCCCCCCC', title: '仍开放', status: 'OPEN', method: 'simulation' }
  ]
}), 'utf-8')
writeFileSync(loopPath, JSON.stringify({ state: 'running', deferredScenarioIds: ['SCN-AAAAAAAA', 'SCN-BBBBBBBB', 'SCN-CCCCCCCC'] }), 'utf-8')
assert.deepEqual(readVerifLoopLedger(workspace).deferredScenarioIds.map((item) => item.scenarioId), ['SCN-CCCCCCCC'],
  'VERIFIED/WAIVED 场景读取时自动退役（deferred 语义失效）')
updateVerifLoopLedger(workspace, (l) => { l.state = 'completed' })
assert.deepEqual(readVerifLoopLedger(workspace).deferredScenarioIds.map((item) => item.scenarioId), ['SCN-CCCCCCCC'],
  '写入路径同样过滤已退役条目')
// 全部退役 → 归一为 undefined（不产生空数组噪声）
writeFileSync(loopPath, JSON.stringify({ state: 'running', deferredScenarioIds: ['SCN-AAAAAAAA'] }), 'utf-8')
assert.equal(readVerifLoopLedger(workspace).deferredScenarioIds, undefined, '全部退役后归一为 undefined')

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

console.log('verif-loop-ledger-smoke: OK（批次循环 dispatched→completed/circuit-broken/stopped/awaiting-rtl-fix + history 只裁 completed（非成功结算永久保留） + deferred 对象结构/旧 string[] 归一/VERIFIED-WAIVED 自动退役 + 场景语义标签快照与降级；修复账本三判定落盘 + ≤50 条 + 容错）')
