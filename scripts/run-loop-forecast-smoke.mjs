// 验证长程循环"战略层"数据面——运行预测纯函数（verif-run-forecast.ts）各分支：
// 无态势/速率不足（≤0.5h）/速率与 ETA 正常/预算不足（步数维 insufficient）/预算贴近（tight）/
// 预算充足（sufficient）/速率为 0/置信度（medium/low）/W1 waveProgress 回退/covered>total 边界。
// 与 verif-run-loop-smoke 同模式：node:module 注册别名钩子后动态 import TS 源码。
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const { createRunLoopLedger, resolveRunLoopStartOptions } = await import('../src/main/services/verif-run-loop.ts')
const { computeRunLoopForecast } = await import('../src/main/services/verif-run-forecast.ts')

const NOW = '2026-10-05T12:00:00.000Z'
const START_2H = '2026-10-05T10:00:00.000Z'

/** 账本夹具：默认 2h 窗口、10 拍、50 万 token、近 10 步 6 步有进展。 */
const makeLedger = (mutate = () => {}) => {
  const ledger = createRunLoopLedger(resolveRunLoopStartOptions(), START_2H, true)
  ledger.budget.beats = 10
  ledger.budget.tokensUsed = 500_000
  ledger.lastBeats = Array.from({ length: 10 }, (_, index) => ({
    beat: 10 - index, summary: 's', decisionId: '', verdict: 'x', advanced: index < 6
  }))
  mutate(ledger)
  return ledger
}

/** 态势夹具：specMapping 条款计数（coveredClause/clauseTotal）。 */
const postureOf = (coveredClause, clauseTotal, extra = {}) => ({
  verificationIntents: [],
  specGaps: [],
  coverageHoles: [],
  regressions: [{ passed: true, testsTotal: 2, coverage: {} }],
  formalResults: [],
  specMapping: { clauseTotal, coveredClause },
  ...extra
})

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `期望 ${expected}，实得 ${actual}`)

// ── A. 无态势：全维度无数据 ──
const nullForecast = computeRunLoopForecast(makeLedger(), null, NOW)
assert.equal(nullForecast.covered, null)
assert.equal(nullForecast.total, null)
assert.equal(nullForecast.ratePerHour, null)
assert.equal(nullForecast.recentAdvanceRatio, 0.6) // 只依赖账本 lastBeats
assert.equal(nullForecast.etaHours, null)
assert.equal(nullForecast.budgetProjection, null)
assert.equal(nullForecast.binding, 'unknown')
assert.equal(nullForecast.confidence, 'medium') // 步数 ≥5 且有进展（与态势无关）

// ── B. 速率不足：运行 ≤0.5h 不给速率，eta/预算投影/binding 连锁为 null/unknown ──
const freshLedger = makeLedger((ledger) => { ledger.budget.startedAt = '2026-10-05T11:40:00.000Z' })
const freshForecast = computeRunLoopForecast(freshLedger, postureOf(10, 20), NOW)
assert.equal(freshForecast.covered, 10)
assert.equal(freshForecast.total, 20)
assert.equal(freshForecast.ratePerHour, null)
assert.equal(freshForecast.etaHours, null)
assert.equal(freshForecast.budgetProjection, null)
assert.equal(freshForecast.binding, 'unknown')

// startedAt 不可解析 → 同样无速率
const brokenStart = makeLedger((ledger) => { ledger.budget.startedAt = 'not-a-date' })
assert.equal(computeRunLoopForecast(brokenStart, postureOf(10, 20), NOW).ratePerHour, null)

// ── C. 正常基准：速率/ETA/进展比例/预算投影数值精确断言 ──
const baseForecast = computeRunLoopForecast(makeLedger(), postureOf(10, 20), NOW)
assert.equal(baseForecast.ratePerHour, 5) // 10 条款 / 2h
assert.equal(baseForecast.recentAdvanceRatio, 0.6)
near(baseForecast.etaHours.low, 2.4) // 剩余 10 / 5 × 1.2
near(baseForecast.etaHours.high, 4) // 进展比例 0.6 ≥ 0.5 → ×2
assert.deepEqual(baseForecast.budgetProjection, {
  steps: { projectedClauses: 40 }, // 剩余 40 拍 × 每拍 1 条款（10/10）
  tokens: { projectedClauses: 90 }, // 剩余 4.5e6 / 单位成本 5e4
  wallMinutes: { projectedClauses: 10 } // 剩余 120min = 2h × 5 条款/h
})
assert.equal(baseForecast.binding, 'tight') // min=10 = 剩余 10，余量 0 < 20%
assert.equal(baseForecast.confidence, 'medium')

// 进展比例 <0.5 → ETA high 用 ×3
const slowAdvance = makeLedger((ledger) => {
  ledger.lastBeats = Array.from({ length: 10 }, (_, index) => ({
    beat: 10 - index, summary: 's', decisionId: '', verdict: 'x', advanced: index < 3
  }))
})
const slowForecast = computeRunLoopForecast(slowAdvance, postureOf(10, 20), NOW)
near(slowForecast.recentAdvanceRatio, 0.3)
near(slowForecast.etaHours.low, 2.4)
near(slowForecast.etaHours.high, 6) // ×3

// ── D. 预算不足：步数维投影 < 剩余条款 → insufficient ──
const beatShort = makeLedger((ledger) => { ledger.budget.beats = 45 })
const insufficientForecast = computeRunLoopForecast(beatShort, postureOf(10, 20), NOW)
assert.deepEqual(insufficientForecast.budgetProjection, {
  steps: { projectedClauses: 1 }, // 剩余 5 拍 × 每拍 10/45
  tokens: { projectedClauses: 90 },
  wallMinutes: { projectedClauses: 10 }
})
assert.equal(insufficientForecast.binding, 'insufficient')

// token 维不足：单位成本高、剩余 token 少
const tokenShort = makeLedger((ledger) => {
  ledger.budget.tokensUsed = 4_000_000
  ledger.budget.beats = 10
})
const tokenForecast = computeRunLoopForecast(tokenShort, postureOf(10, 20), NOW)
assert.equal(tokenForecast.budgetProjection.tokens.projectedClauses, 2) // 剩余 1e6 / 成本 4e5 = 2.5 → 2
assert.equal(tokenForecast.binding, 'insufficient') // min=2 < 剩余 10（步数 40 / 墙钟 10 / token 2）

// ── E. 预算充足：余量 ≥20% → sufficient ──
const ampleLedger = createRunLoopLedger(resolveRunLoopStartOptions({ maxWallMinutes: 480 }), '2026-10-05T11:00:00.000Z', true)
ampleLedger.budget.beats = 20
ampleLedger.budget.tokensUsed = 1_000_000
ampleLedger.lastBeats = Array.from({ length: 10 }, (_, index) => ({
  beat: 10 - index, summary: 's', decisionId: '', verdict: 'x', advanced: index < 5
}))
const ampleForecast = computeRunLoopForecast(ampleLedger, postureOf(18, 20), NOW)
assert.equal(ampleForecast.ratePerHour, 18) // 18 条款 / 1h
assert.deepEqual(ampleForecast.budgetProjection, {
  steps: { projectedClauses: 27 }, // 剩余 30 拍 × 每拍 18/20
  tokens: { projectedClauses: 72 }, // 剩余 4e6 / (1e6/18)
  wallMinutes: { projectedClauses: 126 } // 剩余 420min = 7h × 18
})
assert.equal(ampleForecast.binding, 'sufficient')
near(ampleForecast.etaHours.low, (2 / 18) * 1.2)
near(ampleForecast.etaHours.high, (2 / 18) * 2) // 比例 0.5 ≥ 0.5 → ×2

// ── F. 速率为 0：covered=0 → eta null、token 成本无数据 → 投影 null → binding unknown ──
const zeroForecast = computeRunLoopForecast(makeLedger(), postureOf(0, 20), NOW)
assert.equal(zeroForecast.ratePerHour, 0)
assert.equal(zeroForecast.etaHours, null)
assert.equal(zeroForecast.budgetProjection, null)
assert.equal(zeroForecast.binding, 'unknown')

// ── G. 置信度：步数 ≥5 且近 ≤10 步有进展 → medium，否则 low ──
const fourBeats = makeLedger((ledger) => { ledger.budget.beats = 4 })
assert.equal(computeRunLoopForecast(fourBeats, postureOf(10, 20), NOW).confidence, 'low') // 步数不足
const noAdvance = makeLedger((ledger) => {
  ledger.lastBeats = ledger.lastBeats.map((beat) => ({ ...beat, advanced: false }))
})
assert.equal(computeRunLoopForecast(noAdvance, postureOf(10, 20), NOW).confidence, 'low') // 无进展
const fiveBeatsOneAdvance = makeLedger((ledger) => {
  ledger.budget.beats = 5
  ledger.lastBeats = Array.from({ length: 5 }, (_, index) => ({
    beat: 5 - index, summary: 's', decisionId: '', verdict: 'x', advanced: index === 0
  }))
})
assert.equal(computeRunLoopForecast(fiveBeatsOneAdvance, postureOf(10, 20), NOW).confidence, 'medium')

// ── H. W1 waveProgress 回退：specMapping 缺失时取 specClauseCovered/specClauseTotal ──
const w1OnlyPosture = postureOf(undefined, undefined, {
  specMapping: undefined,
  waveProgress: [{ id: 'W1', label: 'W1', status: 'in-progress', scenarioCount: 4, passedCount: 1, specClauseTotal: 8, specClauseCovered: 3 }]
})
const w1Forecast = computeRunLoopForecast(makeLedger(), w1OnlyPosture, NOW)
assert.equal(w1Forecast.covered, 3)
assert.equal(w1Forecast.total, 8)

// ── I. 边界：covered ≥ total → 剩余 0 → ETA 0、binding sufficient（预算不构成约束）──
const doneForecast = computeRunLoopForecast(makeLedger(), postureOf(25, 20), NOW)
assert.equal(doneForecast.ratePerHour, 12.5)
assert.deepEqual(doneForecast.etaHours, { low: 0, high: 0 })
assert.equal(doneForecast.binding, 'sufficient')

// 无拍记录（首拍前）：步数维无数据 → 投影 null → binding unknown
const zeroBeatLedger = makeLedger((ledger) => { ledger.budget.beats = 0 })
const zeroBeatForecast = computeRunLoopForecast(zeroBeatLedger, postureOf(10, 20), NOW)
assert.equal(zeroBeatForecast.budgetProjection, null)
assert.equal(zeroBeatForecast.binding, 'unknown')
assert.equal(zeroBeatForecast.confidence, 'low')

console.log('run-loop-forecast-smoke: OK（无态势/速率不足≤0.5h/正常速率+ETA×2×3/预算不足/贴近/充足/速率为0/置信度medium-low/W1回退/剩余0与首拍边界）')
