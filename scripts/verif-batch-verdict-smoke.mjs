// VERIF 上下文治理第 3 批：批次完成判定与熔断判定（证据绑定，不依赖真实 pi 进程）
// 直接转译 src/main/services/verif-batch-verdict.ts 测试（与 agent-run-watchdog-smoke 同模式）
import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const { judgeBatchCompletion, isDiagnosticStalled, isTransientSessionError, readExecutionPlanBatch } = await import(pathToFileURL(outfile))

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
assert.equal(isTransientSessionError(''), false)
assert.equal(isTransientSessionError(null), false)
assert.equal(isTransientSessionError('cocotb 编译失败：语法错误'), false)
assert.equal(isTransientSessionError('API Key 无效或无权限访问该模型（401）'), false)
assert.equal(isTransientSessionError('模型服务余额不足或套餐已过期（402）'), false)

console.log('verif-batch-verdict-smoke: OK')
