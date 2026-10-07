// VERIF 上下文治理第 3 批：批次完成判定与熔断判定（证据绑定，不依赖真实 pi 进程）
// 直接转译 src/main/services/verif-batch-verdict.ts 测试（与 agent-run-watchdog-smoke 同模式）
import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'moonglass-verif-batch-'))
const outfile = join(dir, 'verif-batch-verdict.mjs')
const source = readFileSync('src/main/services/verif-batch-verdict.ts', 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
})
writeFileSync(outfile, compiled.outputText, 'utf8')
const { judgeBatchCompletion, isDiagnosticStalled, isTransientSessionError, readExecutionPlanBatch, applyScenarioAvoidance, consecutiveCircuitBreakCount, SCENARIO_AVOIDANCE_STREAK_THRESHOLD } = await import(pathToFileURL(outfile))

const workspace = join(dir, 'ws')
mkdirSync(join(workspace, 'verification', 'results', 'dma'), { recursive: true })
mkdirSync(join(workspace, 'verification', 'intelligence'), { recursive: true })

const batchStartedAt = new Date().toISOString()
await new Promise((resolve) => setTimeout(resolve, 5))

// 假场景登记：SCN-AAAAAAAA 已在 dma 模块的 scenario_hits.json 中登记
writeFileSync(
  join(workspace, 'verification', 'results', 'dma', 'scenario_hits.json'),
  JSON.stringify({ rtlHash: 'x', scenarios: [{ id: 'SCN-AAAAAAAA', reached: true, passed: true }] })
)
// posture 在批次开始后重建
writeFileSync(
  join(workspace, 'verification', 'intelligence', 'verification-posture.json'),
  JSON.stringify({ version: 1, generatedAt: new Date().toISOString() })
)

// 完成判定：证据齐（登记 + posture 晚于批次开始）→ complete
const ok = judgeBatchCompletion(workspace, ['SCN-AAAAAAAA'], batchStartedAt)
assert.equal(ok.complete, true)
assert.equal(ok.postureFresh, true)
assert.equal(ok.missingScenarioIds.length, 0)

// 场景缺登记 → 判异常（熔断路径输入），reasons 结构化说明缺哪些
const missing = judgeBatchCompletion(workspace, ['SCN-AAAAAAAA', 'SCN-BBBBBBBB'], batchStartedAt)
assert.equal(missing.complete, false)
assert.deepEqual(missing.missingScenarioIds, ['SCN-BBBBBBBB'])
assert.ok(missing.reasons.some((reason) => reason.includes('SCN-BBBBBBBB')))

// posture 早于批次开始（批次 settle 后未重建）→ 判异常
const stale = judgeBatchCompletion(workspace, ['SCN-AAAAAAAA'], new Date().toISOString())
assert.equal(stale.complete, false)
assert.equal(stale.postureFresh, false)
assert.ok(stale.reasons.some((reason) => reason.includes('verification-posture.json')))

// posture 不存在 → 判异常
const noPosture = judgeBatchCompletion(join(dir, 'empty-ws'), ['SCN-AAAAAAAA'], batchStartedAt)
assert.equal(noPosture.complete, false)
assert.equal(noPosture.postureGeneratedAt, null)

// 嵌套模块目录可发现；场景 ID 大小写归一
mkdirSync(join(workspace, 'verification', 'results', 'nested', 'sub'), { recursive: true })
writeFileSync(
  join(workspace, 'verification', 'results', 'nested', 'sub', 'scenario_hits.json'),
  JSON.stringify({ scenarios: [{ id: 'SCN-CCCCCCCC' }] })
)
assert.equal(judgeBatchCompletion(workspace, ['scn-cccccccc'], batchStartedAt).missingScenarioIds.length, 0)

// ── 口径分离（2026-10-05）：本批新增证据 vs 历史证据重放 ──
// 上面的 SCN-AAAAAAAA / SCN-CCCCCCCC 登记文件落盘晚于 batchStartedAt → 属本批新增证据
const freshVerdict = judgeBatchCompletion(workspace, ['SCN-AAAAAAAA'], batchStartedAt)
assert.deepEqual(freshVerdict.freshScenarioIds, ['SCN-AAAAAAAA'])
assert.deepEqual(freshVerdict.replayedScenarioIds, [])

// 把登记文件回拨到批次开始之前 → 同一场景变成"历史证据重放"，本批无新增执行证据
const replayedDir = join(workspace, 'verification', 'results', 'replayed')
mkdirSync(replayedDir, { recursive: true })
const replayedFile = join(replayedDir, 'scenario_hits.json')
writeFileSync(replayedFile, JSON.stringify({ scenarios: [{ id: 'SCN-DDDDDDDD', reached: true, passed: false }] }))
const past = new Date(Date.parse(batchStartedAt) - 3600_000)
utimesSync(replayedFile, past, past)

const replayed = judgeBatchCompletion(workspace, ['SCN-DDDDDDDD'], batchStartedAt)
// complete 仍成立：批次会话契约的要求是"有登记 + 态势已重建"，不因重放而变（诊断类批次按约定交付即为完成）
assert.equal(replayed.complete, true)
assert.equal(replayed.missingScenarioIds.length, 0)
assert.deepEqual(replayed.replayedScenarioIds, ['SCN-DDDDDDDD'])
assert.deepEqual(replayed.freshScenarioIds, [])
assert.ok(replayed.reasons.some((reason) => reason.includes('未取得新增执行证据')), '空转批次必须给出结构化说明')

// 部分新增 + 部分重放：reasons 只点出重放的那些，不误报整批无证据
const partial = judgeBatchCompletion(workspace, ['SCN-AAAAAAAA', 'SCN-DDDDDDDD'], batchStartedAt)
assert.deepEqual(partial.freshScenarioIds, ['SCN-AAAAAAAA'])
assert.deepEqual(partial.replayedScenarioIds, ['SCN-DDDDDDDD'])
assert.ok(partial.reasons.some((reason) => reason.includes('仅有历史登记') && !reason.includes('未取得新增执行证据')))

// 同一场景在多个文件中登记时取最新一份：旧文件回拨不影响"本批新增"的判定
const bothDir = join(workspace, 'verification', 'results', 'both')
mkdirSync(bothDir, { recursive: true })
const bothFile = join(bothDir, 'scenario_hits.json')
writeFileSync(bothFile, JSON.stringify({ scenarios: [{ id: 'SCN-DDDDDDDD' }] }))
const latest = judgeBatchCompletion(workspace, ['SCN-DDDDDDDD'], batchStartedAt)
assert.deepEqual(latest.freshScenarioIds, ['SCN-DDDDDDDD'], '较新的登记应覆盖较旧的一份')
assert.deepEqual(latest.replayedScenarioIds, [])

// 批次选择：计划文件缺失返回 null（由编排层重建后重读）；存在时取前 limit 个
assert.equal(readExecutionPlanBatch(workspace, 3), null)
writeFileSync(
  join(workspace, 'verification', 'intelligence', 'scenario-execution-plan.json'),
  JSON.stringify({ plans: [{ scenarioId: 'SCN-1' }, { scenarioId: 'SCN-2' }, { scenarioId: 'SCN-3' }, { scenarioId: 'SCN-4' }] })
)
assert.deepEqual(readExecutionPlanBatch(workspace, 3), ['SCN-1', 'SCN-2', 'SCN-3'])
assert.deepEqual(readExecutionPlanBatch(workspace, 10), ['SCN-1', 'SCN-2', 'SCN-3', 'SCN-4'])

// 熔断判定：DIAGNOSTIC_ENHANCEMENT 且本批诊断等级无爬升 → stalled
const failedAt = (levels) => levels.map((level) => ({ diagnosticLevel: `L${level}`, passed: false }))
assert.equal(
  isDiagnosticStalled({ mode: 'NORMAL_DEBUG', attempts: failedAt([1, 1]) }, { mode: 'DIAGNOSTIC_ENHANCEMENT', attempts: failedAt([1, 1, 1, 1]) }),
  true
)
// before 为空、整段都是本批尝试且等级持平 → stalled
assert.equal(isDiagnosticStalled(null, { mode: 'DIAGNOSTIC_ENHANCEMENT', attempts: failedAt([1, 1]) }), true)
// 本批诊断等级有爬升 → 不熔断
assert.equal(
  isDiagnosticStalled({ mode: 'NORMAL_DEBUG', attempts: failedAt([1]) }, { mode: 'DIAGNOSTIC_ENHANCEMENT', attempts: failedAt([1, 2]) }),
  false
)
// 本批有 PASS → 不熔断
assert.equal(
  isDiagnosticStalled(null, { mode: 'DIAGNOSTIC_ENHANCEMENT', attempts: [...failedAt([1]), { diagnosticLevel: 'L1', passed: true }] }),
  false
)
// 本批无新尝试 → 不算本批熔断条件（由证据缺失判定兜底）
assert.equal(
  isDiagnosticStalled({ mode: 'DIAGNOSTIC_ENHANCEMENT', attempts: failedAt([1, 1]) }, { mode: 'DIAGNOSTIC_ENHANCEMENT', attempts: failedAt([1, 1]) }),
  false
)
// 未进入 DIAGNOSTIC_ENHANCEMENT → 不熔断
assert.equal(isDiagnosticStalled(null, { mode: 'NORMAL_DEBUG', attempts: failedAt([0]) }), false)
assert.equal(isDiagnosticStalled(null, null), false)

// 瞬时供应商故障分类（批次自动重试放行类别；PSRAM_CTRL 批次 7 空响应实测案例）
assert.equal(isTransientSessionError('Provider returned an empty response'), true)
assert.equal(isTransientSessionError('模型服务暂时不可用（502 Bad Gateway）'), true)
assert.equal(isTransientSessionError('模型服务限流，请稍后重试或切换模型（429）'), true)
assert.equal(isTransientSessionError('fetch failed'), true)
assert.equal(isTransientSessionError('socket hang up'), true)
assert.equal(isTransientSessionError('request timed out after 30000ms'), true)
// 中文挂起口径（实测 '[pi-rpc] 等待 Agent 事件超时' 曾不被识别 → 批次挂起 60 分钟不重试）
assert.equal(isTransientSessionError('[pi-rpc] 等待 Agent 事件超时'), true)
assert.equal(isTransientSessionError('等待 Agent 事件超时（60000ms）'), true)
assert.equal(isTransientSessionError('模型服务无响应，连接已断开'), true)
assert.equal(isTransientSessionError('请求超时，请稍后重试'), true)
assert.equal(isTransientSessionError(''), false)
assert.equal(isTransientSessionError(null), false)
assert.equal(isTransientSessionError('cocotb 编译失败：语法错误'), false)
assert.equal(isTransientSessionError('API Key 无效或无权限访问该模型（401）'), false)
assert.equal(isTransientSessionError('模型服务余额不足或套餐已过期（402）'), false)

// ── 批次选择避让（4a，实测 DEC_Visinex：同一对场景 novelty=0 连续 4 轮选中→失败→熔断→再选）──
// history 新在前；verdict 口径：circuit-broken/no-evidence 计次，completed 清零
const pairHistory = [
  { scenarioIds: ['SCN-AAAAAAAA', 'SCN-BBBBBBBB'], verdict: 'circuit-broken' },
  { scenarioIds: ['SCN-AAAAAAAA', 'SCN-BBBBBBBB'], verdict: 'no-evidence' },
  { scenarioIds: ['SCN-AAAAAAAA', 'SCN-BBBBBBBB'], verdict: 'completed' },
  { scenarioIds: ['SCN-AAAAAAAA', 'SCN-BBBBBBBB'], verdict: 'circuit-broken' }
]
// 连续熔断次数：自最新向旧计，遇 completed 清零隔断；不涉及该场景的条目不影响
assert.equal(SCENARIO_AVOIDANCE_STREAK_THRESHOLD, 2)
assert.equal(consecutiveCircuitBreakCount(pairHistory, 'SCN-AAAAAAAA'), 2)
assert.equal(consecutiveCircuitBreakCount(pairHistory, 'SCN-BBBBBBBB'), 2)
assert.equal(consecutiveCircuitBreakCount(pairHistory, 'scn-aaaaaaaa'), 2, '场景 ID 大小写归一比较')
assert.equal(consecutiveCircuitBreakCount(pairHistory, 'SCN-CCCCCCCC'), 0)
// 最新一条涉及该场景的条目是 completed → 连续计数清零
assert.equal(consecutiveCircuitBreakCount([{ scenarioIds: ['SCN-AAAAAAAA'], verdict: 'completed' }, ...pairHistory], 'SCN-AAAAAAAA'), 0)
// 单次熔断（streak=1）不避让，避免抖动误伤
assert.equal(consecutiveCircuitBreakCount([{ scenarioIds: ['SCN-DDDDDDDD'], verdict: 'circuit-broken' }], 'SCN-DDDDDDDD'), 1)
// 其他场景的条目不影响本场景计数（交错批次）
assert.equal(consecutiveCircuitBreakCount([
  { scenarioIds: ['SCN-AAAAAAAA'], verdict: 'circuit-broken' },
  { scenarioIds: ['SCN-EEEEEEEE'], verdict: 'completed' },
  { scenarioIds: ['SCN-AAAAAAAA'], verdict: 'no-evidence' }
], 'SCN-AAAAAAAA'), 2)

// 连续熔断降级：≥2 的场景自本批降级，本批只取未熔断/低熔断场景（保持原相对顺序）
assert.deepEqual(
  applyScenarioAvoidance(['SCN-AAAAAAAA', 'SCN-CCCCCCCC', 'SCN-BBBBBBBB', 'SCN-DDDDDDDD'], pairHistory),
  ['SCN-CCCCCCCC', 'SCN-DDDDDDDD']
)
// 全部被熔断场景占满 → 原样返回（交外层 rule-stall 升级）
assert.deepEqual(applyScenarioAvoidance(['SCN-AAAAAAAA', 'SCN-BBBBBBBB'], pairHistory), ['SCN-AAAAAAAA', 'SCN-BBBBBBBB'])
// 无熔断场景 → 原样返回
assert.deepEqual(applyScenarioAvoidance(['SCN-CCCCCCCC', 'SCN-DDDDDDDD'], pairHistory), ['SCN-CCCCCCCC', 'SCN-DDDDDDDD'])
// 聚类内执行语义：输出恒为输入子集（只减不增、不跨批拼凑），大小写/空白归一且去重
const avoided = applyScenarioAvoidance(['scn-aaaaaaaa', ' SCN-CCCCCCCC ', 'SCN-CCCCCCCC'], pairHistory)
assert.deepEqual(avoided, ['SCN-CCCCCCCC'])
assert.ok(avoided.every((id) => ['SCN-AAAAAAAA', 'SCN-CCCCCCCC'].includes(id)))
assert.equal(applyScenarioAvoidance([], pairHistory).length, 0)

console.log('verif-batch-verdict-smoke: OK')
