/**
 * RTL 修复会话的确定性判定与 prompt 构造（M3，设计文档 §4 方案 B）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path，不引入 electron，
 * 供 AgentService 修复会话编排调用，并可由临时冒烟脚本直接转译测试
 * （与 verif-batch-verdict.ts 同口径：判定绑定工具登记证据，不读会话文本）。
 *
 * 触发链路：验证会话 record_root_cause（verdict=confirmed）调用成功
 * → AgentService 在该会话登记 pendingRtlFix → 会话 settle 后派发独立修复会话
 * → 修复会话 settle 后用 judgeRtlFixOutcome 判定回归结果并回送来源会话。
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** 修复会话的触发记录：record_root_cause verdict=confirmed 工具结果（result.details.record 子集）。 */
export interface PendingRtlFix {
  /** 根因记录 ID（RC-*） */
  rootCauseId: string
  /** 关联场景 ID（SCN-*） */
  scenarioId: string
  hypothesis: string
  rootCause: string
  /** 动作级修复描述（修复会话要执行的内容） */
  fix: string
  /** 关联 diagnostic-control 失败指纹 */
  failureSignature: string
  /** 证据路径（日志/波形/result.json），不是内容 */
  evidence: string[]
}

/**
 * 从 pi tool_execution_end 事件提取已确认根因（M3 事件检测的唯一入口）。
 * 非 record_root_cause 工具、工具出错（isError）、verdict 非 confirmed、
 * 或 details.record 缺 id/scenarioId 时返回 null。
 */
export function extractConfirmedRtlFix(event: Record<string, unknown>): PendingRtlFix | null {
  if (event.type !== 'tool_execution_end') return null
  if (Boolean(event.isError)) return null
  if (String(event.toolName ?? '') !== 'record_root_cause') return null
  const result = (event.result ?? {}) as { details?: { record?: Record<string, unknown> } }
  const record = result.details?.record
  if (!record || record.verdict !== 'confirmed') return null
  const rootCauseId = String(record.id ?? '')
  const scenarioId = String(record.scenarioId ?? '')
  if (!rootCauseId || !scenarioId) return null
  return {
    rootCauseId,
    scenarioId,
    hypothesis: String(record.hypothesis ?? ''),
    rootCause: String(record.rootCause ?? ''),
    fix: String(record.fix ?? ''),
    failureSignature: String(record.failureSignature ?? ''),
    evidence: Array.isArray(record.evidence) ? record.evidence.map(String) : []
  }
}

export type RtlFixOutcome = 'FIXED' | 'STILL_FAIL' | 'UNKNOWN'

export interface RtlFixJudgment {
  outcome: RtlFixOutcome
  scenarioId: string
  /** 最新 hit 登记的 rtlHash（修复后回归时的 RTL 版本；无新证据时为 null） */
  rtlHash: string | null
  /** 最新 hit 登记的证据路径（相对 scenario_hits.json 所在目录或绝对路径） */
  evidence: string[]
  /** 判定理由（送达来源会话与 UI 通知共用） */
  reason: string
}

/**
 * 修复结果判定（M3 §4.5）：读 verification/results/<topModule>/scenario_hits.json 中
 * 该 scenarioId 的最新 hit（按 generatedAt 取最新）。fixStartedAt（修复会话派发时刻，
 * ISO 字符串可字典序比较）之前的 hit 属于修复前证据，不计入：
 * - FIXED：修复后有新 hit 且 PASS（hit.rtlHash 即当前 RTL 版本的证据）
 * - STILL_FAIL：修复后有新 hit 且 FAIL
 * - UNKNOWN：该场景无任何登记，或 rtlHash 未变且无新 hit（修复会话未重跑回归）
 */
export function judgeRtlFixOutcome(workspaceDir: string, scenarioId: string, fixStartedAt: string): RtlFixJudgment {
  const target = scenarioId.toUpperCase()
  interface ScenarioHit { passed: boolean; rtlHash: string | null; evidence: string[]; generatedAt: string }
  const hits: ScenarioHit[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (entry.name !== 'scenario_hits.json') continue
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as {
          rtlHash?: unknown
          scenarios?: Array<{ id?: unknown; passed?: unknown; rtlHash?: unknown; evidence?: unknown; generatedAt?: unknown }>
        }
        for (const item of data.scenarios ?? []) {
          if (String(item.id ?? '').toUpperCase() !== target) continue
          hits.push({
            passed: item.passed === true,
            rtlHash: typeof item.rtlHash === 'string' ? item.rtlHash : (typeof data.rtlHash === 'string' ? data.rtlHash : null),
            evidence: Array.isArray(item.evidence) ? item.evidence.map(String) : [],
            generatedAt: typeof item.generatedAt === 'string' ? item.generatedAt : ''
          })
        }
      } catch { /* 忽略损坏的登记文件（与 verif-batch-verdict 同口径） */ }
    }
  }
  walk(join(workspaceDir, 'verification', 'results'))

  // 同一 scenarioId 可能散落在多个 topModule 目录：按 generatedAt 取最新 hit
  let latest: ScenarioHit | null = null
  for (const hit of hits) {
    if (!latest || hit.generatedAt > latest.generatedAt) latest = hit
  }

  if (!latest) {
    return { outcome: 'UNKNOWN', scenarioId: target, rtlHash: null, evidence: [], reason: 'scenario_hits 中无该场景的登记记录（修复会话未重跑回归）' }
  }
  if (!latest.generatedAt || latest.generatedAt <= fixStartedAt) {
    return { outcome: 'UNKNOWN', scenarioId: target, rtlHash: latest.rtlHash, evidence: latest.evidence, reason: 'rtlHash 未变且无修复后的新 hit（修复会话未产生该场景的新回归证据）' }
  }
  if (latest.passed) {
    return { outcome: 'FIXED', scenarioId: target, rtlHash: latest.rtlHash, evidence: latest.evidence, reason: `当前 rtlHash 下回归 PASS（hit 登记于 ${latest.generatedAt}）` }
  }
  return { outcome: 'STILL_FAIL', scenarioId: target, rtlHash: latest.rtlHash, evidence: latest.evidence, reason: `当前 rtlHash 下回归仍 FAIL（hit 登记于 ${latest.generatedAt}）` }
}

/**
 * 修复会话 prompt（确定性构造，无 LLM 参与）：根因记录全文 + 固定住的 testcase
 * （取自 diagnostic-control.json 的 activeCase，缺失时要求 Agent 从诊断账本自取）+
 * verification/results/ 下相关证据文件路径（嵌路径不嵌内容）。
 */
export function buildRtlFixPrompt(workspaceDir: string, fix: PendingRtlFix): string {
  // 固定住的 testcase：与 verif-batch-verdict.ts 同口径读取 diagnostic-control.json（activeCase = <topModule>::<testcase>）
  let topModule = ''
  let testcase = ''
  try {
    const diagnostic = JSON.parse(readFileSync(join(workspaceDir, 'verification', 'results', 'diagnostic-control.json'), 'utf-8')) as { activeCase?: unknown }
    const [top = '', test = ''] = String(diagnostic.activeCase ?? '').split('::')
    topModule = top
    testcase = test
  } catch { /* 诊断账本缺失时由 Agent 从证据自行定位固定用例 */ }

  const rerunHint = topModule
    ? `run_simulation(mode="cocotb", topModule="${topModule}"${testcase && testcase !== 'all' ? `, testcase="${testcase}"` : ''}, scenarioIds=["${fix.scenarioId}"], rtlFiles=[rtl/filelist.f 中的设计文件])`
    : `run_simulation(..., scenarioIds=["${fix.scenarioId}"])；固定 testcase/seed 请从 verification/results/diagnostic-control.json 的 activeCase 与既有证据确认，不得更换`

  return [
    '[MoonGlass 编排] RTL 修复任务（一锤子：执行已确认的修复 + 回归验证）',
    '',
    '根因已在验证会话中确认并登记。本会话只负责执行修复与回归验证，不做新的诊断假设；假设与诊断状态机留在验证会话。',
    '',
    '## 根因记录（record_root_cause，verdict=confirmed）',
    `- 记录 ID：${fix.rootCauseId}`,
    `- 场景：${fix.scenarioId}`,
    `- 假设：${fix.hypothesis}`,
    `- 根因：${fix.rootCause}`,
    `- 修复指令：${fix.fix}`,
    `- 失败指纹：${fix.failureSignature || '（无）'}`,
    `- 已登记证据：${fix.evidence.length ? fix.evidence.join('、') : '（无）'}`,
    '',
    '## 执行指令',
    '1. 按上面"修复指令"对 rtl/ 做最小修改；仅限 RTL，不得修改 testcase、预期、Checker 或 Scoreboard 来迎合 RTL。',
    `2. 修改后用固定 testcase/seed 重跑回归：${rerunHint}。PASS/FAIL 都会自动登记 scenario_hits.json，禁止手写或修改该文件。`,
    '3. 完成后简要报告：修改了哪些文件、回归结果（PASS/FAIL）、证据路径（日志/波形）。',
    '',
    '## 证据位置（只读参考，嵌路径不嵌内容）',
    `- 场景登记：verification/results/${topModule || '<topModule>'}/scenario_hits.json`,
    '- 诊断账本：verification/results/diagnostic-control.json',
    '- 根因链：verification/results/root-causes.json',
    `- 失败证据（日志/波形）：${fix.evidence.length ? fix.evidence.join('、') : '见 scenario_hits.json 登记'}`,
    '',
    '若修复后回归仍 FAIL：不要在本会话继续提新假设或反复修改 RTL，如实报告 FAIL 与证据路径即可——诊断循环在验证会话继续（会在 root-causes.json 开新假设链）。'
  ].join('\n')
}
