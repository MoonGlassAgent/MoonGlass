import type { VerifRunClosurePlan } from '@shared/types'

/**
 * 验证长程循环"战略层"摘要生成内核（呈现层契约：一个数 + 一句话 + 一个按钮）。
 *
 * 唯一常驻硬指标（闭环率 coverageText）与机器生成的一行战略摘要（headline）在此推导；
 * 本模块不依赖任何 i18n 实现，只产出文案 key 与插值参数，由调用方注入
 * RunSummaryTranslate 完成解析（渲染端薄壳注入 i18n 的 t()；主进程运行循环注入自己的
 * 解析实现），口径与 verification-guidance.ts 的 GuidanceTranslate 一致。
 *
 * 数据契约（与主进程任务逐字固定）：closurePlan 为 run-loop.json 可选字段（类型为
 * shared 的 VerifRunClosurePlan）；预测 forecast 数值字段均可 null/缺省，本模块一律归一
 * （无速率 → 起步中；无预测明细 → 回退预算文案等），禁止对缺数据静默渲染出不可信结论。
 */

/** 闭环计划策略枚举（与 VerifRunClosurePlan.strategy 同源） */
export type RunLoopStrategy = VerifRunClosurePlan['strategy']

/** 预算约束维度（binding 与预算警示共用） */
export type RunBudgetDimension = 'steps' | 'tokens' | 'wall'

/**
 * 预测（主进程产出，渲染端不计算；数值字段均可 null/缺省）。
 * etaHours/budgetProjection 整体可为 null；内部数值字段亦可为 null。
 */
export interface RunLoopForecast {
  covered: number | null
  total: number | null
  ratePerHour: number | null
  recentAdvanceRatio: number | null
  etaHours: { low: number | null; high: number | null } | null
  budgetProjection: {
    steps: { projectedClauses: number | null }
    tokens: { projectedClauses: number | null }
    wallMinutes: { projectedClauses: number | null }
  } | null
  binding: 'sufficient' | 'tight' | 'insufficient' | 'unknown'
  confidence: 'low' | 'medium'
}

/** 摘要行用到的全部界面文案 key（渲染端注入的 t() 必须能解析每个 key） */
export type RunSummaryMessageKey =
  | 'verifRun.loop.summary.blocked'
  | 'verifRun.loop.summary.warmup'
  | 'verifRun.loop.summary.insufficient'
  | 'verifRun.loop.summary.strategy'
  | 'verifRun.loop.summary.normalWithEta'
  | 'verifRun.loop.summary.normalNoEta'
  | 'verifRun.loop.summary.progressEarly'
  | 'verifRun.loop.summary.progressHalf'
  | 'verifRun.loop.summary.progressDone'
  | 'verifRun.loop.summary.progressNoData'
  | 'verifRun.loop.summary.bindingSufficient'
  | 'verifRun.loop.summary.bindingTight'
  | 'verifRun.loop.summary.bindingInsufficient'
  | 'verifRun.loop.summary.bindingUnknown'
  | 'verifRun.loop.summary.strategyNameNormal'
  | 'verifRun.loop.summary.strategyNameConvergeFirst'
  | 'verifRun.loop.summary.strategyNameDeepDive'
  | 'verifRun.loop.summary.strategyNameSteadyRegression'
  | 'verifRun.loop.summary.strategyReasonConvergeFirst'
  | 'verifRun.loop.summary.strategyReasonDeepDive'
  | 'verifRun.loop.summary.strategyReasonSteadyRegression'
  | 'verifRun.loop.summary.forecastNote'
  | 'verifRun.loop.summary.coverage'
  | 'verifRun.loop.summary.coverageStale'
  | 'verifRun.loop.summary.coverageNone'
  | 'verifRun.loop.summary.waveUnknown'
  | 'verifRun.loop.summary.dimSteps'
  | 'verifRun.loop.summary.dimTokens'
  | 'verifRun.loop.summary.dimWall'
  | 'verifRun.loop.summary.budgetEnough'
  | 'verifRun.loop.summary.budgetShort'
  | 'verifRun.loop.summary.budgetWarning'

/** 文案解析回调：由调用方注入（渲染端为 i18n 的 t()），shared 不绑定任何 i18n 实现 */
export type RunSummaryTranslate = (key: RunSummaryMessageKey, params?: Record<string, string | number>) => string

/** 摘要语气（决定渲染端着色：normal 灰 / strategy 蓝 / warning 琥珀 / blocked 红） */
export type RunSummaryTone = 'normal' | 'strategy' | 'warning' | 'blocked'

/** buildRunSummary 输入（数据契约字段；loopState/budgetWarning 为契约预留输入，本批规则链不引用） */
export interface BuildRunSummaryInput {
  /** 当前波段（如 W1）；null 时摘要用占位符 */
  wave: string | null
  /** 闭环率分子（已验证）；null 时回退 forecast.covered */
  covered: number | null
  /** 闭环率分母（总数）；null 时回退 forecast.total */
  total: number | null
  /** 陈旧通过条数（待回归）；null/>0 之外不追加 */
  stale: number | null
  /** 预测（主进程产出；本渲染端批次只透传 prop，可为 null） */
  forecast: RunLoopForecast | null
  /** 闭环计划（账本内嵌；strategy 与未决项数量的来源） */
  closurePlan: VerifRunClosurePlan | null
  /** 循环状态（规则链预留：状态相关文案后续批次接入） */
  loopState: string
  /** 待人工处置的一句话（非空即 blocked，优先级最高） */
  pendingHumanSummary: string | null
  /** 预算警示（琥珀条数据源；由 computeBudgetWarning 产出） */
  budgetWarning: { dimension: RunBudgetDimension; used: number; max: number } | null
}

/** 摘要行输出：一个数（coverageText）+ 一句话（headline + tone）+ 附注（forecastNote） */
export interface RunSummary {
  headline: string
  tone: RunSummaryTone
  forecastNote: string | null
  coverageText: string
}

const STRATEGY_NAME_KEYS: Record<RunLoopStrategy, RunSummaryMessageKey> = {
  normal: 'verifRun.loop.summary.strategyNameNormal',
  'converge-first': 'verifRun.loop.summary.strategyNameConvergeFirst',
  'deep-dive': 'verifRun.loop.summary.strategyNameDeepDive',
  'steady-regression': 'verifRun.loop.summary.strategyNameSteadyRegression'
}

const STRATEGY_REASON_KEYS: Record<Exclude<RunLoopStrategy, 'normal'>, RunSummaryMessageKey> = {
  'converge-first': 'verifRun.loop.summary.strategyReasonConvergeFirst',
  'deep-dive': 'verifRun.loop.summary.strategyReasonDeepDive',
  'steady-regression': 'verifRun.loop.summary.strategyReasonSteadyRegression'
}

const BINDING_TEXT_KEYS: Record<RunLoopForecast['binding'], RunSummaryMessageKey> = {
  sufficient: 'verifRun.loop.summary.bindingSufficient',
  tight: 'verifRun.loop.summary.bindingTight',
  insufficient: 'verifRun.loop.summary.bindingInsufficient',
  unknown: 'verifRun.loop.summary.bindingUnknown'
}

/** 非负有限数归一：null/NaN/负数一律视为缺数据 */
function nonNegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** binding 归一：非法值按 unknown 处理（缺数据不给结论） */
function normalizeBinding(value: unknown): RunLoopForecast['binding'] {
  return value === 'sufficient' || value === 'tight' || value === 'insufficient' ? value : 'unknown'
}

/** 策略归一：非法/缺失按 normal 处理（无 closurePlan 即无策略态） */
function normalizeStrategy(value: unknown): RunLoopStrategy {
  return value === 'converge-first' || value === 'deep-dive' || value === 'steady-regression' ? value : 'normal'
}

/** 预算投影归一：取三个维度里最先触顶的（最小 projectedClauses）；全无数据返回 null */
function minProjectedClauses(forecast: RunLoopForecast): number | null {
  const projection = forecast.budgetProjection
  if (!projection) return null
  const values = [projection.steps?.projectedClauses, projection.tokens?.projectedClauses, projection.wallMinutes?.projectedClauses]
    .map(nonNegative)
    .filter((value): value is number => value !== null)
  return values.length > 0 ? Math.min(...values) : null
}

/** 进度一句话：按闭环率分档（≥100% 达标 / ≥50% 过半 / 其余推进中；无数据只给定性词） */
function progressPhrase(covered: number | null, total: number | null, tr: RunSummaryTranslate): string {
  if (covered === null || total === null || total <= 0) return tr('verifRun.loop.summary.progressNoData')
  if (covered >= total) return tr('verifRun.loop.summary.progressDone', { covered, total })
  if (covered * 2 >= total) return tr('verifRun.loop.summary.progressHalf', { covered, total })
  return tr('verifRun.loop.summary.progressEarly', { covered, total })
}

/**
 * 生成战略摘要行。规则链（优先级从高到低，与产品确认）：
 * 1. 有 pendingHumanSummary → blocked「{wave} · {pendingHumanSummary}」；
 * 2. 无 forecast/有效速率 → 「{wave} · 起步中，尚无速率数据」；
 * 3. binding='insufficient' 且有覆盖/投影数据 → warning 预算不足行；
 * 4. strategy ≠ normal → strategy 策略行（含策略中文名与理由一句）；
 * 5. 正常行：进度一句话 + ETA 区间（etaHours 缺省时回退无 ETA 句式）+ 预算 binding 文案。
 * forecast.confidence='low' 时附预测仅供参考注（forecastNote）。
 */
export function buildRunSummary(input: BuildRunSummaryInput, tr: RunSummaryTranslate): RunSummary {
  const forecast = input.forecast
  const covered = nonNegative(input.covered) ?? nonNegative(forecast?.covered)
  const total = nonNegative(input.total) ?? nonNegative(forecast?.total)
  const stale = nonNegative(input.stale)
  const wave = input.wave?.trim() ? input.wave : tr('verifRun.loop.summary.waveUnknown')

  const coverageText = covered !== null && total !== null && total > 0
    ? stale !== null && stale > 0
      ? tr('verifRun.loop.summary.coverageStale', { covered, total, stale })
      : tr('verifRun.loop.summary.coverage', { covered, total })
    : tr('verifRun.loop.summary.coverageNone')

  const pendingHuman = input.pendingHumanSummary?.trim()
  let headline: string
  let tone: RunSummaryTone
  if (pendingHuman) {
    headline = tr('verifRun.loop.summary.blocked', { wave, summary: pendingHuman })
    tone = 'blocked'
  } else {
    const rate = nonNegative(forecast?.ratePerHour)
    if (!forecast || rate === null || rate <= 0) {
      headline = tr('verifRun.loop.summary.warmup', { wave })
      tone = 'normal'
    } else {
      const fcCovered = nonNegative(forecast.covered) ?? covered
      const fcTotal = nonNegative(forecast.total) ?? total
      const projected = minProjectedClauses(forecast)
      const binding = normalizeBinding(forecast.binding)
      if (binding === 'insufficient' && fcCovered !== null && fcTotal !== null && fcTotal > 0 && projected !== null) {
        headline = tr('verifRun.loop.summary.insufficient', { wave, covered: fcCovered, total: fcTotal, projected })
        tone = 'warning'
      } else {
        const strategy = normalizeStrategy(input.closurePlan?.strategy)
        if (strategy !== 'normal' && input.closurePlan) {
          const unmet = Math.max(0, input.closurePlan.totalCount - input.closurePlan.metCount)
          const reason = tr(STRATEGY_REASON_KEYS[strategy], { count: unmet })
          headline = tr('verifRun.loop.summary.strategy', { wave, strategy: tr(STRATEGY_NAME_KEYS[strategy]), reason })
          tone = 'strategy'
        } else {
          tone = 'normal'
          const progress = progressPhrase(fcCovered, fcTotal, tr)
          const bindingText = tr(BINDING_TEXT_KEYS[binding])
          const low = nonNegative(forecast.etaHours?.low)
          const high = nonNegative(forecast.etaHours?.high)
          if (forecast.etaHours && low !== null && high !== null) {
            headline = tr('verifRun.loop.summary.normalWithEta', { wave, progress, low: Math.round(low), high: Math.round(high), binding: bindingText })
          } else {
            headline = tr('verifRun.loop.summary.normalNoEta', { wave, progress, binding: bindingText })
          }
        }
      }
    }
  }

  const forecastNote = forecast && forecast.confidence === 'low' ? tr('verifRun.loop.summary.forecastNote') : null
  return { headline, tone, forecastNote, coverageText }
}

/** 预算快照（与 VerifRunLoopBudget 同字段子集；墙钟含续跑累计基数） */
export interface RunLoopBudgetSnapshot {
  beats: number
  maxBeats: number
  tokensUsed: number
  maxTokens: number
  startedAt: string
  maxWallMinutes: number
  wallResetBase?: number
}

/** 预算警示：超阈值的最严重维度（used/max 比值最大者） */
export interface RunBudgetWarning {
  dimension: RunBudgetDimension
  used: number
  max: number
}

/**
 * 预算警示阈值计算：任一维度 used/max 严格 > 0.8 才返回，取比值最严重的维度；
 * 墙钟按当前窗口（nowMs - startedAt）+ 续跑累计基数计算。forecast 为数据契约预留输入，
 * 本批按使用率取最严重维度，"预计够/不够"的裁决由调用方结合 forecast.binding 渲染。
 */
export function computeBudgetWarning(budget: RunLoopBudgetSnapshot, forecast: RunLoopForecast | null, nowMs: number): RunBudgetWarning | null {
  void forecast
  const startedAtMs = Date.parse(budget.startedAt)
  const wallUsed = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((nowMs - startedAtMs) / 60_000)) + (budget.wallResetBase ?? 0)
    : 0
  const candidates: RunBudgetWarning[] = [
    { dimension: 'steps', used: budget.beats, max: budget.maxBeats },
    { dimension: 'tokens', used: budget.tokensUsed, max: budget.maxTokens },
    { dimension: 'wall', used: wallUsed, max: budget.maxWallMinutes }
  ]
  let worst: RunBudgetWarning | null = null
  let worstRatio = 0.8
  for (const item of candidates) {
    if (item.max <= 0) continue
    const ratio = item.used / item.max
    if (ratio > worstRatio) {
      worstRatio = ratio
      worst = item
    }
  }
  return worst
}
