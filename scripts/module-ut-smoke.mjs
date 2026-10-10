// 模块级轻量 UT（MODULE-UT，docs/MODULE-UT-DESIGN-ZH-CN.md）smoke：
//  1) 账本归一：坏 JSON 降级空账本、坏条目丢弃好条目保留；
//  2) acquire：同模块 active 幂等拒绝、不同模块并行合法、utId 形态 UT-<8hex>；
//  3) release：completed/interrupted 两态落账、未知 utId 与重复释放幂等返回 null；
//  4) 启动对账：active → interrupted（app-restart），返回被中断清单且幂等；
//  5) 互斥判定：activeCount/activeModules/门控原因（含模块列表）；
//  6) 软建议：rtl-fix-audit-*.json changed 计数 ≥2 触发，1 小时冷却去重；
//  7) 模块→文件匹配、失败指纹收集（root-causes.json / rtl-fix-outcomes.json）与 §6 prompt 契约要点。
// module-ut.ts 为无 electron 依赖纯模块，与 decision-ledger-smoke 同模式直接转译导入。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  MODULE_UT_CHURN_THRESHOLD,
  MODULE_UT_SUGGEST_COOLDOWN_MS,
  acquireModuleUt,
  buildModuleUtPrompt,
  collectModuleUtFailureHints,
  countRtlFileFixChurn,
  matchModuleRtlFiles,
  moduleUtActiveCount,
  moduleUtActiveModules,
  moduleUtLedgerPath,
  moduleUtReportRelDir,
  moduleUtRunLoopGateReason,
  moduleUtSuggestionDue,
  readModuleUtLedger,
  reconcileModuleUtAfterRestart,
  releaseModuleUt,
  writeModuleUtLedger
} = await import('../src/main/services/module-ut.ts')

const workspace = mkdtempSync(join(tmpdir(), 'moonglass-module-ut-'))

// ===== 1. 账本归一：坏 JSON 降级空账本 =====
mkdirSync(join(workspace, 'verification', 'results'), { recursive: true })
writeFileSync(moduleUtLedgerPath(workspace), '{not-json', 'utf-8')
let ledger = readModuleUtLedger(workspace)
assert.deepEqual(ledger, { version: 1, sessions: [] }, '坏 JSON 必须降级为空账本')
writeFileSync(moduleUtLedgerPath(workspace), JSON.stringify({ version: 1, sessions: 'nope' }), 'utf-8')
ledger = readModuleUtLedger(workspace)
assert.deepEqual(ledger, { version: 1, sessions: [] }, 'sessions 非数组必须降级为空账本')
// 坏条目丢弃、好条目保留
writeFileSync(moduleUtLedgerPath(workspace), JSON.stringify({
  version: 1,
  sessions: [
    { utId: 'UT-AAAABBBB', module: 'good', sessionName: 's1', state: 'active', startedAt: '2026-10-10T00:00:00.000Z' },
    { utId: '', module: 'bad-no-utid', sessionName: 's2', state: 'active', startedAt: '2026-10-10T00:00:00.000Z' },
    { module: 'bad-no-fields' },
    { utId: 'UT-CCCCDDDD', module: 'bad-state', sessionName: 's3', state: 'weird', startedAt: '2026-10-10T00:00:00.000Z' },
    null
  ]
}), 'utf-8')
ledger = readModuleUtLedger(workspace)
assert.equal(ledger.sessions.length, 1, '坏条目丢弃、好条目保留')
assert.equal(ledger.sessions[0].module, 'good')

// ===== 2. acquire：幂等拒绝 / 并行合法 / utId 形态 =====
writeFileSync(moduleUtLedgerPath(workspace), JSON.stringify({ version: 1, sessions: [] }), 'utf-8')
const first = acquireModuleUt(workspace, 'gmac_rx_mac', 'phase-verif--ut-gmac_rx_mac', '2026-10-10T01:00:00.000Z')
assert.equal(first.ok, true)
if (first.ok) assert.match(first.utId, /^UT-[0-9A-F]{8}$/, 'utId 应为 UT-<8hex 大写>')
const dup = acquireModuleUt(workspace, 'gmac_rx_mac', 'phase-verif--ut-gmac_rx_mac-2', '2026-10-10T01:05:00.000Z')
assert.equal(dup.ok, false, '同模块 active UT 必须幂等拒绝')
if (!dup.ok) assert.match(dup.reason, /已在进行中/)
const parallel = acquireModuleUt(workspace, 'gmac_tx_mac', 'phase-verif--ut-gmac_tx_mac', '2026-10-10T01:06:00.000Z')
assert.equal(parallel.ok, true, '不同模块 UT 并行合法')
ledger = readModuleUtLedger(workspace)
assert.equal(ledger.sessions.length, 2, '幂等拒绝不得追加条目')
assert.equal(ledger.sessions.filter((s) => s.state === 'active').length, 2)
// 已终态的同模块条目不阻断再次 acquire
releaseModuleUt(workspace, first.ok ? first.utId : '', 'completed', { reportPath: 'verification/results/ut/gmac_rx_mac/report.md' }, '2026-10-10T01:30:00.000Z')
const reacquire = acquireModuleUt(workspace, 'gmac_rx_mac', 'phase-verif--ut-gmac_rx_mac-3', '2026-10-10T02:00:00.000Z')
assert.equal(reacquire.ok, true, '同模块上一轮 UT 已完成后可再次发起')

// ===== 3. release：两态落账 / 未知与重复释放幂等 =====
const completedEntry = readModuleUtLedger(workspace).sessions.find((s) => s.state === 'completed')
assert.ok(completedEntry, 'completed 落账应保留在账本')
assert.equal(completedEntry.settledAt, '2026-10-10T01:30:00.000Z')
assert.equal(completedEntry.reportPath, 'verification/results/ut/gmac_rx_mac/report.md')
assert.equal(releaseModuleUt(workspace, 'UT-NOTEXIST', 'interrupted'), null, '未知 utId 释放返回 null')
assert.equal(releaseModuleUt(workspace, completedEntry.utId, 'interrupted'), null, '已终态条目重复释放返回 null')
const interruptTarget = acquireModuleUt(workspace, 'npu_core', 'phase-verif--ut-npu_core', '2026-10-10T02:10:00.000Z')
assert.equal(interruptTarget.ok, true)
const interrupted = releaseModuleUt(
  workspace,
  interruptTarget.ok ? interruptTarget.utId : '',
  'interrupted',
  { note: 'UT 会话被 watchdog 熔断：重复写文件' },
  '2026-10-10T02:20:00.000Z'
)
assert.equal(interrupted?.state, 'interrupted', 'interrupted 终态落账')
assert.match(interrupted?.note ?? '', /watchdog/, '异常路径 note 须留痕不静默吞')

// ===== 4. 启动对账：active → interrupted（app-restart），幂等 =====
acquireModuleUt(workspace, 'modem_top', 'phase-verif--ut-modem_top', '2026-10-10T03:00:00.000Z')
acquireModuleUt(workspace, 'rf_ctrl', 'phase-verif--ut-rf_ctrl', '2026-10-10T03:01:00.000Z')
let interruptedList = reconcileModuleUtAfterRestart(workspace, '2026-10-10T09:00:00.000Z')
assert.equal(interruptedList.length, 4, '此前未释放的 4 个 active 锁都应被中断释放（含 §2/§3 遗留）')
assert.deepEqual(interruptedList.map((i) => i.module).sort(), ['gmac_rx_mac', 'gmac_tx_mac', 'modem_top', 'rf_ctrl'])
assert.equal(interruptedList.find((i) => i.module === 'modem_top')?.sessionName, 'phase-verif--ut-modem_top')
ledger = readModuleUtLedger(workspace)
for (const entry of ledger.sessions.filter((s) => s.state === 'interrupted' && ['gmac_rx_mac', 'gmac_tx_mac', 'modem_top', 'rf_ctrl'].includes(s.module))) {
  assert.equal(entry.state, 'interrupted')
  assert.equal(entry.settledAt, '2026-10-10T09:00:00.000Z')
  assert.match(entry.note ?? '', /app-restart/)
  assert.match(entry.note ?? '', /RTL 可能处于半截修改状态，请确认现场后再恢复/, '中断提示措辞须包含半截修改警告')
}
interruptedList = reconcileModuleUtAfterRestart(workspace, '2026-10-10T09:30:00.000Z')
assert.equal(interruptedList.length, 0, '启动对账幂等：无 active 锁时返回空清单且不改账')

// ===== 5. 互斥判定：activeCount / activeModules / 门控原因 =====
assert.equal(moduleUtActiveCount(workspace), 0, '全部终态后活跃计数归零')
assert.equal(moduleUtRunLoopGateReason(workspace), null, '锁归零后门控放行')
acquireModuleUt(workspace, 'alpha', 'phase-verif--ut-alpha', '2026-10-10T10:00:00.000Z')
acquireModuleUt(workspace, 'beta', 'phase-verif--ut-beta', '2026-10-10T10:01:00.000Z')
assert.equal(moduleUtActiveCount(workspace), 2)
assert.deepEqual(moduleUtActiveModules(workspace), ['alpha', 'beta'])
const gate = moduleUtRunLoopGateReason(workspace)
assert.ok(gate, '锁非空时门控必须拦截')
assert.match(gate, /2 个/)
assert.match(gate, /alpha/)
assert.match(gate, /beta/)
assert.match(gate, /互斥挂起/)

// ===== 6. 软建议：churn 计数与 1 小时冷却去重 =====
const resultsDir = join(workspace, 'verification', 'results')
writeFileSync(join(resultsDir, 'rtl-fix-audit-RC-00000001.json'), JSON.stringify({
  rootCauseId: 'RC-00000001', scenarioId: 'SCN-A', fixSessionName: 'f1',
  startedAt: '2026-10-10T00:00:00.000Z', settledAt: '2026-10-10T00:30:00.000Z',
  changed: ['sub/gmac_rx_mac.v', 'fifo_sync.v'], created: [], deleted: [], blockedAttempts: 0
}), 'utf-8')
writeFileSync(join(resultsDir, 'rtl-fix-audit-RC-00000002.json'), JSON.stringify({
  rootCauseId: 'RC-00000002', scenarioId: 'SCN-B', fixSessionName: 'f2',
  startedAt: '2026-10-10T01:00:00.000Z', settledAt: '2026-10-10T01:30:00.000Z',
  changed: ['sub\\gmac_rx_mac.v'], created: [], deleted: [], blockedAttempts: 1
}), 'utf-8')
writeFileSync(join(resultsDir, 'rtl-fix-audit-RC-00000003.json'), JSON.stringify({
  rootCauseId: 'RC-00000003', scenarioId: 'SCN-C', fixSessionName: 'f3',
  startedAt: '2026-10-10T02:00:00.000Z', settledAt: '2026-10-10T02:30:00.000Z',
  changed: ['fifo_sync.v'], created: [], deleted: [], blockedAttempts: 0
}), 'utf-8')
assert.equal(countRtlFileFixChurn(workspace, 'sub/gmac_rx_mac.v'), 2, '反斜杠路径归一后须与正斜杠 key 视为同一文件（rtl/ 相对 key 口径）')
assert.equal(countRtlFileFixChurn(workspace, 'fifo_sync.v'), 2)
assert.equal(countRtlFileFixChurn(workspace, 'absent.v'), 0)
assert.ok(countRtlFileFixChurn(workspace, 'sub/gmac_rx_mac.v') >= MODULE_UT_CHURN_THRESHOLD, 'churn ≥2 达软建议阈值')
assert.equal(moduleUtSuggestionDue(null, 1_000_000), true, '从未提示则应提示')
assert.equal(moduleUtSuggestionDue(1_000_000, 1_000_000 + MODULE_UT_SUGGEST_COOLDOWN_MS - 1), false, '冷却窗口内不重复提示')
assert.equal(moduleUtSuggestionDue(1_000_000, 1_000_000 + MODULE_UT_SUGGEST_COOLDOWN_MS), true, '冷却窗口过后可再次提示')

// ===== 7. 模块→文件匹配 / 失败指纹收集 / §6 prompt 契约要点 =====
const designFiles = ['D:/ws/rtl/gmac_rx_mac.v', 'D:/ws/rtl\\sub\\fifo_sync.v', 'D:/ws/rtl/top.v']
assert.deepEqual(matchModuleRtlFiles('gmac_rx_mac', designFiles), ['D:/ws/rtl/gmac_rx_mac.v'])
assert.deepEqual(matchModuleRtlFiles('fifo_sync', designFiles), ['D:/ws/rtl\\sub\\fifo_sync.v'])
assert.deepEqual(matchModuleRtlFiles('missing', designFiles), [], '无匹配返回空（调用方拒绝派发）')

writeFileSync(join(resultsDir, 'root-causes.json'), JSON.stringify({
  version: 1,
  records: [
    { id: 'RC-AAAA1111', scenarioId: 'SCN-01', hypothesis: 'h', verdict: 'confirmed', refutedHypotheses: [], failureSignature: 'gmac_rx_mac 输出在复位释放后 X', rootCause: 'gmac_rx_mac 复位同步级数不足', fix: '加一级同步', evidence: [], createdAt: '2026-10-09T00:00:00.000Z' },
    { id: 'RC-BBBB2222', scenarioId: 'SCN-02', hypothesis: 'h2', verdict: 'open', refutedHypotheses: [], failureSignature: '', rootCause: '', fix: '', evidence: [], createdAt: '2026-10-09T01:00:00.000Z' }
  ]
}), 'utf-8')
writeFileSync(join(resultsDir, 'rtl-fix-outcomes.json'), JSON.stringify({
  version: 1,
  outcomes: [
    { rootCauseId: 'RC-AAAA1111', scenarioId: 'SCN-01', fixSessionName: 'f1', judgment: 'STILL_FAIL', reason: 'gmac_rx_mac 边界仍 FAIL', startedAt: '2026-10-09T02:00:00.000Z', settledAt: '2026-10-09T03:00:00.000Z', auditPath: 'verification/results/rtl-fix-audit-RC-AAAA1111.json', blockedAttempts: 0 }
  ]
}), 'utf-8')
const hints = collectModuleUtFailureHints(workspace, 'gmac_rx_mac')
assert.equal(hints.rootCauseHints.length, 1, '提及模块名的 confirmed 根因被收集')
assert.match(hints.rootCauseHints[0], /RC-AAAA1111/)
assert.match(hints.rootCauseHints[0], /gmac_rx_mac 复位同步级数不足/)
assert.match(hints.rootCauseHints[0], /失败指纹：gmac_rx_mac/)
assert.equal(hints.fixOutcomeHints.length, 1, '提及模块名的修复判定被收集')
assert.match(hints.fixOutcomeHints[0], /STILL_FAIL/)
// 缺文件降级空
const emptyWorkspace = mkdtempSync(join(tmpdir(), 'moonglass-module-ut-empty-'))
assert.deepEqual(collectModuleUtFailureHints(emptyWorkspace, 'any'), { rootCauseHints: [], fixOutcomeHints: [] })

const prompt = buildModuleUtPrompt({
  moduleName: 'gmac_rx_mac',
  rtlFiles: ['D:/ws/rtl/gmac_rx_mac.v'],
  rootCauseHints: hints.rootCauseHints,
  fixOutcomeHints: hints.fixOutcomeHints
})
for (const marker of [
  '模块级轻量 UT 会话', 'gmac_rx_mac', 'probe 隔离', 'scenario_hits', '不计入闭环证据',
  '不免除全量重回归', '不动主验证环境', '只读', 'cocotb', '单上下文',
  moduleUtReportRelDir('gmac_rx_mac'), 'report.md', '迭代自由', '结束条件', '卡点',
  '禁止扩大范围', '历史失败指纹', 'RC-AAAA1111', 'STILL_FAIL', 'root-causes.json', 'rtl-fix-outcomes.json'
]) {
  assert.ok(prompt.includes(marker), `UT prompt 缺少契约要点：${marker}`)
}
assert.equal(moduleUtReportRelDir('gmac_rx_mac'), 'verification/results/ut/gmac_rx_mac/')
assert.ok(!moduleUtReportRelDir('a/b').includes('a/b'), '模块名路径安全化')

// 账本原子写回读一致
writeModuleUtLedger(workspace, { version: 1, sessions: [] })
assert.equal(existsSync(moduleUtLedgerPath(workspace)), true)
assert.equal(readModuleUtLedger(workspace).sessions.length, 0)

console.log('[module-ut-smoke] OK')
