/**
 * 流程看板数据层（BOARD-AND-REVIEW-CLOSED-LOOP 片 B，设计文档 §2/§5）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path 与既有账本读取模块，不引入 electron，
 * 供 ipc.ts 的 board:get-model handler 调用，并可由 scripts/board-model-smoke.mjs
 * 直接转译测试（与 decision-ledger.ts / module-ut.ts 同口径）。
 *
 * 归一口径（设计文档 §2：全部来自既有账本，不新造数据管道）：
 *  - 批次       verification/results/verif-batch-loop.json → kind='batch'
 *  - RTL 修复  verification/results/rtl-fix-outcomes.json → kind='rtl-fix'
 *  - 运行循环  verification/results/run-loop.json         → kind='run-loop'
 *  - 决策提案  verification/results/decision-ledger.json  → kind='decision'
 *  - 模块 UT  verification/results/ut-sessions.json      → kind='module-ut'
 *  - 设计审查  reports/review-request.json                → kind='design-review'
 *
 * 尝试记录（attempt）：每次派发一次新会话 = 一次尝试；模型取账本登记的会话实际用模
 * （仅 design-review 的 reviewModel 落盘），其余账本未登记留空。
 * 任务状态五类由最近一次尝试判定推导；缺文件/坏 JSON 一律降级为空集合，绝不抛错。
 * 看板是只读视图，不与编排耦合。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PHASE_ORDER } from '@shared/types'
import type { Phase, VerifRunLoopState } from '@shared/types'
import type { BoardAttempt, BoardAttemptVerdict, BoardModel, BoardTask, BoardTaskStatus } from '@shared/ipc-contract'
import { readVerifLoopLedger } from './verif-loop-ledger.ts'
import { readRtlFixOutcomeLedger } from './rtl-fix-outcome-ledger.ts'
import { readDecisionLedger } from './decision-ledger.ts'
import { readModuleUtLedger } from './module-ut.ts'
import { readVerifRunLoopLedger } from './verif-run-loop.ts'

/** 任务卡标题长度上限（卡片一句话，超出截断防运行输出刷爆）。 */
const BOARD_TASK_TITLE_MAX = 80
/** 尝试记录 note 长度上限（一句话判定理由）。 */
const BOARD_ATTEMPT_NOTE_MAX = 120
/** review-request.json 相对路径（与 AgentService.DESIGN_REVIEW_REQUEST_REL_PATH 同契约）。 */
const REVIEW_REQUEST_REL_PATH = join('reports', 'review-request.json')

/** 单行截断：超长按字裁剪（note/title 均一句话口径）。 */
function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * 尝试判定 → 任务状态五类（设计文档 §2 统一卡片模型）：
 * success/running 同语义直映；failed/circuit-broken/error=要求修改（红）；
 * no-evidence=会话 settle 但无执行证据（合法出口、延后重选），无自动修复路径，待人确认（黄）。
 */
function taskStatusFromVerdict(verdict: BoardAttemptVerdict): BoardTaskStatus {
  switch (verdict) {
    case 'success':
      return 'success'
    case 'running':
      return 'running'
    case 'failed':
    case 'circuit-broken':
    case 'error':
      return 'needs-fix'
    case 'no-evidence':
      return 'pending-human'
  }
}

/** 任务状态：无尝试记录 = 未开始；否则取最近一次尝试判定（attempts 一律按时间升序）。 */
function taskStatusFromAttempts(attempts: readonly BoardAttempt[]): BoardTaskStatus {
  if (attempts.length === 0) return 'not-started'
  return taskStatusFromVerdict(attempts[attempts.length - 1].verdict)
}

/** 会话名 → 阶段：phase-<阶段小写> 主会话名前缀 + `--` 平行会话（批次/修复/UT 等），与 artifact-drift 的口径同构。 */
const SESSION_PHASE_PATTERN = /^phase-(req_spec|arch|rtl|verif|qa|synth)(?:--|$)/

function phaseFromSessionName(sessionName: string, fallback: Phase): Phase {
  const matched = SESSION_PHASE_PATTERN.exec(sessionName.trim().toLowerCase())
  if (!matched) return fallback
  const phase = matched[1].toUpperCase() as Phase
  return PHASE_ORDER.includes(phase) ? phase : fallback
}

/** 任务最近一次活动时间（settledAt/startedAt 取最大）：列内卡片按时间序列排序用；无时间戳排最后。 */
function taskActivityKey(task: BoardTask): string {
  let latest = ''
  for (const attempt of task.attempts) {
    const stamp = attempt.settledAt && attempt.settledAt >= attempt.startedAt ? attempt.settledAt : attempt.startedAt
    if (stamp > latest) latest = stamp
  }
  return latest
}

/** 批次任务标题：优先语义标签快照的场景标题（派发时口径），缺快照回退场景 ID 列表。 */
function batchTitle(index: number, labels: readonly { title: string }[] | undefined, scenarioIds: readonly string[]): string {
  const names = (labels ?? []).map((item) => item.title.trim()).filter(Boolean)
  const fallback = names.length > 0 ? names : scenarioIds.map(String)
  const head = fallback.slice(0, 3).join('、')
  const suffix = fallback.length > 3 ? ` 等 ${fallback.length} 项` : ''
  return clip(`VERIF 批次 ${index}：${head || '（无场景快照）'}${suffix}`, BOARD_TASK_TITLE_MAX)
}

// ==================== 批次（verif-batch-loop.json） ====================

function buildBatchTasks(workspace: string): { tasks: BoardTask[]; updatedAt: string } {
  const ledger = readVerifLoopLedger(workspace)
  if (!ledger) return { tasks: [], updatedAt: '' }
  const tasks: BoardTask[] = []
  // 历史批次（新在前）：每批次 = 单会话单尝试 = 一张任务卡
  for (const entry of ledger.history) {
    const verdict: BoardAttemptVerdict = entry.verdict === 'completed' ? 'success' : entry.verdict
    tasks.push({
      id: `batch-${entry.index}`,
      kind: 'batch',
      title: batchTitle(entry.index, entry.scenarios, entry.scenarioIds),
      phase: 'VERIF',
      status: taskStatusFromVerdict(verdict),
      attempts: [{
        index: 1,
        model: '',
        verdict,
        startedAt: '', // 历史条目不记派发时刻（账本无此字段），settledAt/note 已够审计
        ...(entry.settledAt ? { settledAt: entry.settledAt } : {}),
        note: clip(entry.reason, BOARD_ATTEMPT_NOTE_MAX)
      }]
    })
  }
  // 在跑批次：dispatched（会话执行中）与 settling（会话已结束、完成判定中）均算进行中
  if (ledger.currentBatch) {
    const current = ledger.currentBatch
    tasks.push({
      id: `batch-${current.index}`,
      kind: 'batch',
      title: batchTitle(current.index, current.scenarios, current.scenarioIds),
      phase: phaseFromSessionName(current.sessionName, 'VERIF'),
      status: 'running',
      attempts: [{
        index: 1,
        model: '',
        verdict: 'running',
        startedAt: current.dispatchedAt,
        note: current.phase === 'settling' ? '批次会话已结束，完成判定中' : '批次会话执行中'
      }]
    })
  }
  return { tasks, updatedAt: ledger.updatedAt }
}

// ==================== RTL 修复（rtl-fix-outcomes.json） ====================

function buildRtlFixTasks(workspace: string): { tasks: BoardTask[]; updatedAt: string } {
  const ledger = readRtlFixOutcomeLedger(workspace)
  const byRootCause = new Map<string, typeof ledger.outcomes>()
  for (const record of ledger.outcomes) {
    if (!record.rootCauseId) continue // 无根因 ID 的坏条目无法成卡，丢弃
    const group = byRootCause.get(record.rootCauseId) ?? []
    group.push(record)
    byRootCause.set(record.rootCauseId, group)
  }
  const tasks: BoardTask[] = []
  for (const [rootCauseId, records] of byRootCause) {
    // 每次修复会话 = 一次尝试；账本新在前，按派发时刻还原为时间升序（时刻缺失的稳定序兜底）
    const ordered = [...records].sort((a, b) => (a.startedAt || a.settledAt).localeCompare(b.startedAt || b.settledAt))
    const latest = ordered[ordered.length - 1]
    const attempts: BoardAttempt[] = ordered.map((record, index) => {
      // FIXED=修复生效；STILL_FAIL=仍失败；UNKNOWN=判定不明（未取得修复生效证据 → no-evidence）
      const verdict: BoardAttemptVerdict = record.judgment === 'FIXED' ? 'success' : record.judgment === 'STILL_FAIL' ? 'failed' : 'no-evidence'
      return {
        index: index + 1,
        model: '',
        verdict,
        startedAt: record.startedAt,
        ...(record.settledAt ? { settledAt: record.settledAt } : {}),
        note: clip(record.reason, BOARD_ATTEMPT_NOTE_MAX)
      }
    })
    tasks.push({
      id: rootCauseId,
      kind: 'rtl-fix',
      title: clip(`RTL 修复 ${rootCauseId}${latest.scenarioId ? `（场景 ${latest.scenarioId}）` : ''}`, BOARD_TASK_TITLE_MAX),
      phase: phaseFromSessionName(latest.fixSessionName, 'VERIF'),
      status: taskStatusFromAttempts(attempts),
      attempts
    })
  }
  return { tasks, updatedAt: '' }
}

// ==================== 设计审查（reports/review-request.json） ====================

/** 读取 review-request.json 请求清单；缺文件/坏 JSON/结构非法一律返回空数组（与 AgentService 读取口径一致）。 */
function readReviewRequestRecords(workspace: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(readFileSync(join(workspace, REVIEW_REQUEST_REL_PATH), 'utf-8')) as unknown
    const requests = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).requests : null
    if (!Array.isArray(requests)) return []
    return requests.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
  } catch {
    return []
  }
}

function buildDesignReviewTasks(workspace: string): { tasks: BoardTask[]; updatedAt: string } {
  const tasks: BoardTask[] = []
  for (const record of readReviewRequestRecords(workspace)) {
    const type = String(record.type ?? '')
    // 仅两类合法审查类型成卡（与 request_design_review 工具校验口径一致），其余坏条目跳过
    if (type !== 'arch-consistency' && type !== 'rtl-semantic') continue
    const phase: Phase = type === 'arch-consistency' ? 'ARCH' : 'RTL'
    const roundRaw = Number(record.round)
    const round = Number.isFinite(roundRaw) && roundRaw > 0 ? Math.trunc(roundRaw) : 1
    const scope = typeof record.scope === 'string' ? clip(record.scope, BOARD_ATTEMPT_NOTE_MAX) : ''
    const consumed = record.consumed === true
    const lastError = typeof record.lastError === 'string' ? record.lastError.trim() : ''
    // 结算口径：已消费（正常 settle）=success；未消费但有 lastError=error；否则审查会话进行中/待派发=running
    const verdict: BoardAttemptVerdict = consumed ? 'success' : lastError ? 'error' : 'running'
    const startedAt = typeof record.requestedAt === 'string' ? record.requestedAt : ''
    tasks.push({
      id: `review-${type}-${round}`,
      kind: 'design-review',
      title: clip(`${type === 'arch-consistency' ? 'ARCH 一致性审查' : 'RTL 语义审查'}（第 ${round} 轮）${scope ? `：${scope}` : ''}`, BOARD_TASK_TITLE_MAX),
      phase,
      status: taskStatusFromVerdict(verdict),
      attempts: [{
        index: 1,
        // 会话实际用模仅在 settle 消费时落盘（reviewModel），未消费留空
        model: consumed && typeof record.reviewModel === 'string' ? record.reviewModel : '',
        verdict,
        startedAt,
        ...(consumed && typeof record.consumedAt === 'string' && record.consumedAt ? { settledAt: record.consumedAt } : {}),
        note: consumed ? (scope || '审查会话正常 settle') : lastError ? clip(lastError, BOARD_ATTEMPT_NOTE_MAX) : (scope || '审查请求已登记，等待审查会话 settle')
      }]
    })
  }
  return { tasks, updatedAt: '' }
}

// ==================== 模块 UT（ut-sessions.json） ====================

function buildModuleUtTasks(workspace: string): { tasks: BoardTask[]; updatedAt: string } {
  const ledger = readModuleUtLedger(workspace)
  const byModule = new Map<string, typeof ledger.sessions>()
  for (const entry of ledger.sessions) {
    const group = byModule.get(entry.module) ?? []
    group.push(entry)
    byModule.set(entry.module, group)
  }
  const tasks: BoardTask[] = []
  for (const [moduleName, sessions] of byModule) {
    // 账本按开始先后追加（= 时间升序）：每次 UT 会话 = 一次尝试
    const latest = sessions[sessions.length - 1]
    const attempts: BoardAttempt[] = sessions.map((entry, index) => ({
      index: index + 1,
      model: '',
      verdict: entry.state === 'completed' ? 'success' as const : entry.state === 'active' ? 'running' as const : 'error' as const,
      startedAt: entry.startedAt,
      ...(entry.settledAt ? { settledAt: entry.settledAt } : {}),
      ...(entry.note ? { note: clip(entry.note, BOARD_ATTEMPT_NOTE_MAX) } : {})
    }))
    tasks.push({
      id: `ut-${moduleName}`,
      kind: 'module-ut',
      title: clip(`模块 UT：${moduleName}`, BOARD_TASK_TITLE_MAX),
      phase: phaseFromSessionName(latest.sessionName, 'VERIF'),
      status: taskStatusFromAttempts(attempts),
      attempts
    })
  }
  return { tasks, updatedAt: '' }
}

// ==================== 决策提案（decision-ledger.json） ====================

function buildDecisionTasks(workspace: string): { tasks: BoardTask[]; updatedAt: string } {
  const ledger = readDecisionLedger(workspace)
  if (!ledger) return { tasks: [], updatedAt: '' }
  const tasks: BoardTask[] = []
  for (const decision of ledger.decisions) {
    // 否决/被取代的提案已终结、无后续动作，不进流程看板（看板只呈现"进行中的工作"）
    if (decision.status === 'rejected' || decision.status === 'superseded') continue
    const titleSource = clip(decision.action.prompt.trim() || decision.humanSummary?.trim() || decision.rationale.trim() || decision.id, BOARD_TASK_TITLE_MAX)
    const note = decision.humanSummary?.trim() || decision.rationale.trim()
    const noteClipped = note ? clip(note, BOARD_ATTEMPT_NOTE_MAX) : undefined
    let status: BoardTaskStatus
    let attempts: BoardAttempt[]
    if (decision.status === 'proposed') {
      status = 'pending-human' // 待人批准/否决（批准入口保留在决策卡）
      attempts = []
    } else if (decision.status === 'approved') {
      status = 'running' // 已批准、待循环拾取执行（账本不记派发时刻）
      attempts = [{ index: 1, model: '', verdict: 'running', startedAt: '', ...(noteClipped ? { note: noteClipped } : {}) }]
    } else {
      // executed：按执行结果回填裁决（advanced/no-progress/failed），未回填=outcome null 视为仍执行中
      const verdict: BoardAttemptVerdict = decision.outcome === 'advanced' ? 'success' : decision.outcome === 'no-progress' ? 'failed' : decision.outcome === 'failed' ? 'error' : 'running'
      status = taskStatusFromVerdict(verdict)
      attempts = [{ index: 1, model: '', verdict, startedAt: '', ...(noteClipped ? { note: noteClipped } : {}) }]
    }
    tasks.push({
      id: decision.id,
      kind: 'decision',
      title: `决策 ${decision.id}：${titleSource}`,
      phase: 'VERIF',
      status,
      attempts
    })
  }
  return { tasks, updatedAt: '' }
}

// ==================== 运行循环（run-loop.json） ====================

function runLoopTaskStatus(state: VerifRunLoopState): BoardTaskStatus {
  switch (state) {
    case 'completed':
      return 'success'
    case 'running':
    case 'planning':
    case 'judging':
    case 'repairing':
    case 'gate-check':
    case 'signoff-review':
      return 'running'
    case 'paused-human':
      return 'pending-human'
    case 'paused-breaker':
      return 'needs-fix'
    case 'idle':
    case 'stopped':
      return 'not-started'
  }
}

/** 循环步判定 → 尝试判定：advanced=有进展；no-progress=无进展（尝试失败）；failed=会话异常；其余未知口径按 no-evidence 降级。 */
function runLoopBeatVerdict(raw: string): BoardAttemptVerdict {
  return raw === 'advanced' ? 'success' : raw === 'no-progress' ? 'failed' : raw === 'failed' ? 'error' : 'no-evidence'
}

function buildRunLoopTask(workspace: string): { task: BoardTask | null; updatedAt: string } {
  const ledger = readVerifRunLoopLedger(workspace)
  if (!ledger) return { task: null, updatedAt: '' }
  const attempts: BoardAttempt[] = []
  // 最近循环步（新在前）还原为时间序尝试记录；账本不记每步时间戳，startedAt 留空
  for (const beat of [...ledger.lastBeats].reverse()) {
    attempts.push({
      index: attempts.length + 1,
      model: '',
      verdict: runLoopBeatVerdict(beat.verdict),
      startedAt: '',
      note: clip(beat.summary, BOARD_ATTEMPT_NOTE_MAX)
    })
  }
  if (ledger.current) {
    attempts.push({
      index: attempts.length + 1,
      model: '',
      verdict: 'running',
      startedAt: ledger.current.dispatchedAt,
      note: clip(`${ledger.current.kind}${ledger.current.actionId ? ` ${ledger.current.actionId}` : ''}（${ledger.current.source}）`, BOARD_ATTEMPT_NOTE_MAX)
    })
  }
  return {
    task: {
      id: 'run-loop',
      kind: 'run-loop',
      title: '验证运行循环',
      phase: 'VERIF',
      status: runLoopTaskStatus(ledger.state),
      attempts
    },
    updatedAt: ledger.updatedAt
  }
}

// ==================== 看板模型归一入口 ====================

/**
 * 归一项目看板模型：读取全部既有账本，产出 6 阶段列（REQ_SPEC→SYNTH，空列保留）
 * + 任务卡 + 尝试记录；updatedAt 取各账本更新时间的最大值（无账本为空串）。
 * projectId 为 IPC 契约对称预留——账本全部按 workspace 定位，当前归一不读取其值。
 * 任何单一账本缺失/损坏只降级对应来源，其余照常，整体绝不抛错。
 */
export function buildBoardModel(workspace: string, projectId: string): BoardModel {
  const tasksByPhase = new Map<Phase, BoardTask[]>()
  const updatedAts: string[] = []
  const collect = (built: { tasks: BoardTask[]; updatedAt: string }): void => {
    for (const task of built.tasks) {
      const list = tasksByPhase.get(task.phase) ?? []
      list.push(task)
      tasksByPhase.set(task.phase, list)
    }
    if (built.updatedAt) updatedAts.push(built.updatedAt)
  }
  collect(buildBatchTasks(workspace))
  collect(buildRtlFixTasks(workspace))
  collect(buildDecisionTasks(workspace))
  collect(buildModuleUtTasks(workspace))
  collect(buildDesignReviewTasks(workspace))
  const runLoop = buildRunLoopTask(workspace)
  collect({ tasks: runLoop.task ? [runLoop.task] : [], updatedAt: runLoop.updatedAt })

  const phases = PHASE_ORDER.map((phase) => {
    const tasks = tasksByPhase.get(phase) ?? []
    // 列内按任务最近活动时间新在前排序（无时间戳的排最后）；排序稳定，同键保持来源顺序
    tasks.sort((a, b) => {
      const keyA = taskActivityKey(a)
      const keyB = taskActivityKey(b)
      if (keyA === keyB) return 0
      if (!keyA) return 1
      if (!keyB) return -1
      return keyB.localeCompare(keyA)
    })
    return { phase, tasks }
  })
  return { phases, updatedAt: updatedAts.sort().at(-1) ?? '' }
}
