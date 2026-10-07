// 验证长程循环"战略层"摘要生成器 + 预算警示阈值冒烟（呈现层契约：一个数 + 一句话 + 一个按钮）。
// 覆盖：缺数据归一 / blocked 优先 / insufficient 预警 / 策略行 / 正常行含 ETA 区间 /
// coverageText 含待回归 / computeBudgetWarning 80% 阈值与维度选择 / 中英 summary 资源键一致。
// run-summary.ts 是零运行时依赖的纯函数模块，Node 原生类型剥除后直接导入验证。
import assert from 'node:assert/strict'
import { buildRunSummary, computeBudgetWarning } from '../src/shared/run-summary.ts'
import { zhCN } from '../src/renderer/i18n/locales/zh-CN/index.ts'
import { en } from '../src/renderer/i18n/locales/en/index.ts'

/** 渲染端 t() 的最小复刻：嵌套查表（缺 key 直接抛错）+ {param} 插值 */
const makeTr = (messages) => (key, params) => {
  let node = messages
  for (const part of key.split('.')) node = node?.[part]
  if (typeof node !== 'string') throw new Error(`缺失文案资源: ${key}`)
  let text = node
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}
const tr = makeTr(zhCN)

/** 展开 verifRun.loop.summary 的全部点分隔键（中英一致性校验用） */
const flattenKeys = (node, prefix = '') =>
  Object.entries(node).flatMap(([name, value]) =>
    typeof value === 'string' ? [`${prefix}${name}`] : flattenKeys(value, `${prefix}${name}.`))

// 中英资源键一致性：summary 命名空间两边键集合必须完全相等（en 以 typeof zhCN 为约束，运行时双保险）
assert.deepEqual(
  flattenKeys(en.verifRun.loop.summary),
  flattenKeys(zhCN.verifRun.loop.summary),
  'verifRun.loop.summary 中英资源键不一致'
)

const baseInput = {
  wave: 'W1',
  covered: null,
  total: null,
  stale: null,
  forecast: null,
  closurePlan: null,
  loopState: 'running',
  pendingHumanSummary: null,
  budgetWarning: null
}
const normalForecast = {
  covered: 120,
  total: 235,
  ratePerHour: 3,
  recentAdvanceRatio: 0.8,
  etaHours: { low: 20, high: 40 },
  budgetProjection: { steps: { projectedClauses: 300 }, tokens: { projectedClauses: 280 }, wallMinutes: { projectedClauses: 260 } },
  binding: 'sufficient',
  confidence: 'medium'
}

// 1) 缺数据归一：全部为空 → 起步中 + 无覆盖数据 + 无附注
{
  const summary = buildRunSummary(baseInput, tr)
  assert.equal(summary.tone, 'normal')
  assert.ok(summary.headline.includes('起步中，尚无速率数据'), '无 forecast 应回退起步中')
  assert.equal(summary.coverageText, '尚无覆盖数据')
  assert.equal(summary.forecastNote, null)
}
// 1b) forecast 在但速率缺数据（null 字段）→ 仍起步中；波段缺失 → 占位符
{
  const summary = buildRunSummary({ ...baseInput, wave: null, forecast: { ...normalForecast, ratePerHour: null } }, tr)
  assert.ok(summary.headline.startsWith('— ·'), '波段缺失应用占位符开头')
  assert.ok(summary.headline.includes('起步中'), '速率 null 应归一为无速率')
}
// 1c) 有速率但 etaHours 缺数据 → 正常行无 ETA 句式（缺数据归一，不得渲染 NaN 区间）
{
  const summary = buildRunSummary({ ...baseInput, forecast: { ...normalForecast, etaHours: null } }, tr)
  assert.equal(summary.tone, 'normal')
  assert.ok(!summary.headline.includes('还需约'), 'etaHours 缺数据不得渲染 ETA 区间')
  assert.ok(summary.headline.includes('预算充足'), 'binding=sufficient 应渲染预算充足')
}

// 2) blocked 优先：待人工一句话存在时压过 insufficient / 策略 / 正常 ETA
{
  const input = {
    ...baseInput,
    pendingHumanSummary: '4 个场景无解，已提交裁决请求，批准后自动续跑',
    forecast: { ...normalForecast, binding: 'insufficient' },
    closurePlan: { wave: 'W1', strategy: 'converge-first', strategySince: '2026-10-05T00:00:00Z', criteria: [], metCount: 3, totalCount: 5 }
  }
  const summary = buildRunSummary(input, tr)
  assert.equal(summary.tone, 'blocked')
  assert.equal(summary.headline, 'W1 · 4 个场景无解，已提交裁决请求，批准后自动续跑')
}

// 3) insufficient 预警：binding=insufficient → warning 行 + 取三个维度最小 projectedClauses
{
  const forecast = {
    ...normalForecast,
    binding: 'insufficient',
    budgetProjection: { steps: { projectedClauses: 120 }, tokens: { projectedClauses: 200 }, wallMinutes: { projectedClauses: 300 } }
  }
  const summary = buildRunSummary({ ...baseInput, forecast }, tr)
  assert.equal(summary.tone, 'warning')
  assert.ok(summary.headline.includes('按当前打法 120/235'), '预警行应含当前覆盖')
  assert.ok(summary.headline.includes('预算只能走到约 120 条'), 'projected 应取最先触顶维度（min=120）')
  // 预警优先于策略：同输入叠加 converge-first 仍出预警行
  const withStrategy = buildRunSummary({ ...baseInput, forecast, closurePlan: { wave: 'W1', strategy: 'deep-dive', strategySince: '', criteria: [], metCount: 1, totalCount: 5 } }, tr)
  assert.equal(withStrategy.tone, 'warning', 'insufficient 优先级高于策略行')
}

// 4) 策略行：strategy ≠ normal → strategy 语气 + 策略中文名 + 未决项数量理由
{
  const closurePlan = { wave: 'W1', strategy: 'converge-first', strategySince: '2026-10-05T00:00:00Z', criteria: [{ id: 'C1', met: true }, { id: 'C2', met: true }, { id: 'C3', met: false }, { id: 'C4', met: false }], metCount: 2, totalCount: 4 }
  const summary = buildRunSummary({ ...baseInput, forecast: normalForecast, closurePlan }, tr)
  assert.equal(summary.tone, 'strategy')
  assert.ok(summary.headline.includes('已切换「收敛优先」'), '策略行应含策略中文名')
  assert.ok(summary.headline.includes('2 个未决闭环项'), '理由应含未决闭环项数量')
  // 无 closurePlan → 策略归一为 normal，不出策略行
  const noPlan = buildRunSummary({ ...baseInput, forecast: normalForecast }, tr)
  assert.equal(noPlan.tone, 'normal', '缺 closurePlan 不得出策略行')
}

// 5) 正常行含 ETA 区间 + 进度分档 + binding 文案；低置信附注
{
  const summary = buildRunSummary({ ...baseInput, covered: 120, total: 235, forecast: normalForecast }, tr)
  assert.equal(summary.tone, 'normal')
  assert.ok(summary.headline.includes('已过半 120/235'), '进度一句话应按覆盖率分档（≥50% 已过半）')
  assert.ok(summary.headline.includes('按当前速率还需约 20–40 小时'), '正常行应含 ETA 区间')
  assert.ok(summary.headline.includes('预算充足'), 'binding=sufficient → 预算充足')
  assert.equal(summary.forecastNote, null, 'confidence=medium 不附低置信注')
  const lowConfidence = buildRunSummary({ ...baseInput, forecast: { ...normalForecast, confidence: 'low' } }, tr)
  assert.ok(lowConfidence.forecastNote?.includes('预测仅供参考'), 'confidence=low 应附低置信注')
  const early = buildRunSummary({ ...baseInput, covered: 40, total: 235, forecast: { ...normalForecast, covered: 40 } }, tr)
  assert.ok(early.headline.includes('推进中 40/235'), '覆盖率 <50% 应为推进中档')
}

// 6) coverageText：一个数——含待回归追加 + 无数据占位
{
  const stale = buildRunSummary({ ...baseInput, covered: 100, total: 200, stale: 3 }, tr)
  assert.equal(stale.coverageText, '已验证 100/200，含 3 条待回归')
  const plain = buildRunSummary({ ...baseInput, covered: 100, total: 200, stale: 0 }, tr)
  assert.equal(plain.coverageText, '已验证 100/200')
  // input 缺 covered/total 时回退 forecast 的覆盖数
  const fromForecast = buildRunSummary({ ...baseInput, forecast: normalForecast }, tr)
  assert.equal(fromForecast.coverageText, '已验证 120/235')
}

// 7) computeBudgetWarning：>80% 阈值（严格大于）+ 取最严重维度 + 墙钟/续跑基数/非法 max 归一
{
  const t0 = Date.parse('2026-10-05T00:00:00Z')
  const baseBudget = { beats: 40, maxBeats: 50, tokensUsed: 3_000_000, maxTokens: 5_000_000, startedAt: '2026-10-05T00:00:00Z', maxWallMinutes: 240 }
  // 40/50 = 0.8 恰好阈值 → 不警示（严格大于）
  assert.equal(computeBudgetWarning(baseBudget, null, t0), null, '恰好 80% 不应警示')
  // steps 45/50=0.9、tokens 4.3M/5M=0.86 → 取最严重维度 steps
  const warn = computeBudgetWarning({ ...baseBudget, beats: 45, tokensUsed: 4_300_000 }, null, t0)
  assert.deepEqual(warn, { dimension: 'steps', used: 45, max: 50 }, '应取比值最严重的维度（steps 0.9 > tokens 0.86）')
  // tokens 最高 → tokens；墙钟 2h/90min=1.33 → wall 胜出（含跨天 nowMs 推进）
  const t2h = t0 + 2 * 60 * 60_000
  assert.equal(computeBudgetWarning({ ...baseBudget, beats: 45, tokensUsed: 4_900_000 }, null, t0)?.dimension, 'tokens')
  const wall = computeBudgetWarning({ ...baseBudget, beats: 10, tokensUsed: 100_000, maxWallMinutes: 90 }, null, t2h)
  assert.deepEqual(wall, { dimension: 'wall', used: 120, max: 90 }, '墙钟按当前窗口计算，超阈值应警示')
  // 续跑累计基数：窗口 30min + base 60min = 90/100 = 0.9 → wall
  const t30m = t0 + 30 * 60_000
  assert.equal(computeBudgetWarning({ ...baseBudget, beats: 10, tokensUsed: 100_000, maxWallMinutes: 100, wallResetBase: 60 }, null, t30m)?.dimension, 'wall', '墙钟应计入续跑累计基数')
  // max<=0 维度跳过：步数上限 0 不抛错、不入选
  const skipZero = computeBudgetWarning({ ...baseBudget, beats: 45, maxBeats: 0, tokensUsed: 4_900_000 }, null, t0)
  assert.equal(skipZero?.dimension, 'tokens', 'max<=0 的维度应跳过')
  // startedAt 非法 → 墙钟按 0 处理不入选，steps 0.9 胜出
  assert.equal(computeBudgetWarning({ ...baseBudget, beats: 45, startedAt: 'not-a-date' }, null, t0)?.dimension, 'steps')
}

console.log('Run summary smoke passed: normalization, tones, coverage text, budget warning thresholds')
