/**
 * 验证工作台结论契约（P1，2026-10-05）
 *
 * 目的：让工程师不翻会话就能回答"验证完成多少、证据是否仍然有效、签核还缺什么"，
 * 且每条结论都能回到实际证据文件。
 *
 * 本模块是**纯只读投影**：只把姿态/状态 JSON 归一化成一个可显示的结论快照，
 * 不改写任何项目产物、不参与调度、不产生副作用（可在渲染进程与冒烟脚本直接复用）。
 *
 * 两条硬口径（对应"界面结论不可信"缺陷）：
 * 1. **记录通过 ≠ 当前有效通过**：PASSED 只在"证据文件存在 + 证据版本等于当前 RTL +
 *    证据不晚于快照 + 快照版本等于当前 RTL"同时成立时计入 validPassed，否则计入
 *    needsRevalidation（历史通过）。RTL 改动后旧 PASS 不得继续冒充当前有效通过。
 * 2. **没有评估不能推断就绪**：缺失 closureAssessment/signoffPackage 时签核状态只能是
 *    unknown，不得因"零 blocker"显示就绪——"没有阻塞记录"不等于"可以签核"。
 */

/** 单条规格条款的结论明细（供统计卡展开） */
export interface VerificationClauseDetail {
  id: string | null
  parentId: string | null
  text: string | null
  status: 'unmapped' | 'mappedUntested' | 'failed' | 'passed' | 'waived' | 'unknown'
  /** 是否当前有效通过（历史通过为 false） */
  validPassed: boolean
  /** 曾通过但证据陈旧（待回归）；引擎 stalePassed 透出 */
  stalePassed?: boolean
  scenarioIds: string[]
  intentIds: string[]
  evidence: string[]
}

/** 工作台结论快照：保留"记录通过"与"当前有效通过"的差别 */
export interface VerificationWorkbenchSnapshot {
  generatedAt: string | null
  /** 快照来源文件（相对工作区），供界面标注口径出处 */
  source: string | null
  currentRtlHash: string | null
  snapshotRtlHash: string | null
  clauses: {
    /** 可验证条款分母；与明细对账不上时为 null（不静默给假分母） */
    total: number | null
    unmapped: number
    mappedUntested: number
    failed: number
    /** 记录通过（含历史） */
    passed: number
    waived: number
    unknown: number
    /** 当前有效通过（证据与当前 RTL 一致） */
    validPassed: number
    /** 记录通过但证据需重验 */
    needsRevalidation: number
    documentary: number | null
    /** synthesis 通道条款数（不在 VERIF 完备性分母内） */
    synthesis: number
    /** 能可靠关联执行记录的条款数；不可靠时为 null */
    executed: number | null
  }
  clauseDetails?: VerificationClauseDetail[]
  evidence: { status: 'current' | 'stale' | 'missing' | 'unknown'; missing: string[]; stale: string[] }
  signoff: { status: 'not-ready' | 'conditional' | 'review' | 'unknown'; blockers: string[]; warnings: string[] }
  issues: Array<'no-data' | 'mapping-incomplete' | 'version-unknown' | 'snapshot-stale' | 'evidence-missing' | 'evidence-stale' | 'evidence-unconfirmed' | 'evidence-newer'>
}

/** 单个证据引用的磁盘核对结果（由主进程读取后传入） */
export interface WorkbenchEvidence {
  exists: boolean
  rtlHash: string | null
  modifiedAt?: number
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item) => item && typeof item === 'object').map(record) : []
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : []
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
/** 证据引用统一为 POSIX 相对路径，避免 Windows 反斜杠导致查找失配 */
const normalizeRef = (value: string): string => value.replace(/\\/g, '/')

/**
 * 收集快照中引用的全部证据文件（条款证据 + 签核证据包 + 回归/形式化结果文件）。
 * 去重后按相对路径返回，供主进程逐一核对存在性与版本。
 */
export function workbenchEvidenceRefs(raw: unknown): string[] {
  const state = record(raw)
  return [...new Set([
    ...rows(record(state.specMapping).clauses).flatMap((clause) => strings(clause.evidence)),
    ...strings(record(state.signoffPackage).evidenceFiles),
    ...rows(state.regressions).flatMap((run) => (str(run.resultFile) ? [String(run.resultFile)] : [])),
    ...rows(state.formalResults).flatMap((run) => (str(run.resultFile) ? [String(run.resultFile)] : []))
  ].map(normalizeRef))]
}

/** 已成功读到磁盘但尚无可用姿态（未规划或产物被清空）；IPC 失败的 null 不代表"已清空"。 */
export function needsVerificationPlanning(snapshot: VerificationWorkbenchSnapshot | null | undefined): boolean {
  return Boolean(snapshot?.issues?.includes('no-data'))
}

/**
 * 由姿态/状态 JSON 构建结论快照。所有判断均来自结构化事实；
 * evidence 为各证据引用的磁盘核对结果（键与 workbenchEvidenceRefs 同口径）。
 */
export function buildVerificationWorkbench(
  raw: unknown,
  currentRtlHash: string | null,
  evidence: Record<string, WorkbenchEvidence>,
  source: string | null
): VerificationWorkbenchSnapshot {
  const state = record(raw)
  const mapping = record(state.specMapping)
  const closure = record(state.closureAssessment)
  const signoff = record(state.signoffPackage)
  const snapshotRtlHash = str(state.rtlHash)
  const issues: VerificationWorkbenchSnapshot['issues'] = []
  const clauses: VerificationWorkbenchSnapshot['clauses'] = {
    total: count(mapping.clauseTotal), unmapped: 0, mappedUntested: 0, failed: 0, passed: 0, waived: 0, unknown: 0,
    validPassed: 0, needsRevalidation: 0, documentary: count(mapping.documentaryCount), synthesis: 0, executed: null
  }
  // synthesis 通道条款照常追踪，但验收在 SYNTH 阶段，不计入 VERIF 完备性分母（与引擎口径一致）
  const relevant = rows(mapping.clauses).filter((clause) => {
    if (clause.channel === 'synthesis') { clauses.synthesis += 1; return false }
    return clause.clauseKind !== 'documentary' && clause.status !== 'DOCUMENTARY'
  })
  const refs = workbenchEvidenceRefs(raw)
  const missing = refs.filter((ref) => !evidence[ref]?.exists)
  const stale = refs.filter((ref) => Boolean(currentRtlHash) && Boolean(evidence[ref]?.rtlHash) && evidence[ref].rtlHash !== currentRtlHash)
  const versionCurrent = Boolean(currentRtlHash) && snapshotRtlHash === currentRtlHash
  const snapshotTime = Date.parse(str(state.generatedAt) ?? '')
  // 文件时间存在秒级精度差，容忍 1 秒；比姿态更新的证据需要重新评估
  const newer = refs.filter((ref) => Number.isFinite(snapshotTime) && (evidence[ref]?.modifiedAt ?? 0) > snapshotTime + 1000)
  const clauseDetails: VerificationClauseDetail[] = []
  for (const clause of relevant) {
    // 陈旧通过（引擎透出 stalePassed）：曾 PASS 但证据被 RTL 变更作废——归入"待重验"而不是"已映射未验证"，防止双计
    const isStalePassed = clause.stalePassed === true && clause.status !== 'PASSED'
    const key = isStalePassed ? null : ({ UNMAPPED: 'unmapped', MAPPED_UNTESTED: 'mappedUntested', FAILED: 'failed', PASSED: 'passed', WAIVED: 'waived' } as const)[String(clause.status) as 'PASSED']
    if (key) clauses[key] += 1
    let validPassed = false
    if (clause.status === 'PASSED') {
      const proof = strings(clause.evidence).map(normalizeRef)
      const valid = versionCurrent && Number.isFinite(snapshotTime) && proof.length > 0 &&
        proof.every((ref) => evidence[ref]?.exists && !newer.includes(ref) && (!evidence[ref]?.rtlHash || evidence[ref]?.rtlHash === currentRtlHash)) &&
        proof.some((ref) => evidence[ref]?.rtlHash === currentRtlHash)
      if (valid) clauses.validPassed += 1
      else clauses.needsRevalidation += 1
      validPassed = valid
    } else if (isStalePassed) {
      clauses.needsRevalidation += 1
    }
    clauseDetails.push({
      id: str(clause.clauseId), parentId: str(clause.parentId), text: str(clause.text), status: key ?? (isStalePassed ? 'mappedUntested' : 'unknown'), validPassed,
      stalePassed: clause.stalePassed === true,
      scenarioIds: strings(clause.scenarioIds), intentIds: strings(clause.intentIds), evidence: strings(clause.evidence)
    })
  }
  // 记录通过（含历史）= 当前有效 + 曾通过待重验；陈旧通过经 stalePassed 透出后必须计入
  clauses.passed = clauses.validPassed + clauses.needsRevalidation
  // 分母对账：明细条数与 clauseTotal 不一致时明确标记，不静默使用不可靠的分母
  if (clauses.total === null || relevant.length !== clauses.total) {
    issues.push('mapping-incomplete')
    if (clauses.total !== null && relevant.length <= clauses.total) clauses.unknown += clauses.total - relevant.length
    else clauses.total = null
  }
  if (Object.keys(state).length === 0) issues.push('no-data')
  if (!currentRtlHash || !snapshotRtlHash) issues.push('version-unknown')
  else if (!versionCurrent) issues.push('snapshot-stale')
  if (missing.length > 0) issues.push('evidence-missing')
  if (stale.length > 0) issues.push('evidence-stale')
  if (newer.length > 0) issues.push('evidence-newer')
  if (clauses.needsRevalidation > 0 && versionCurrent && missing.length === 0 && stale.length === 0) issues.push('evidence-unconfirmed')

  const evidenceStatus: VerificationWorkbenchSnapshot['evidence']['status'] =
    !currentRtlHash || !snapshotRtlHash ? 'unknown'
      : !versionCurrent || stale.length > 0 ? 'stale'
        : missing.length > 0 ? 'missing'
          : !Number.isFinite(snapshotTime) || newer.length > 0 || refs.length === 0 || clauses.needsRevalidation > 0 || !refs.some((ref) => evidence[ref]?.rtlHash === currentRtlHash) ? 'unknown'
            : 'current'
  if (versionCurrent && evidenceStatus === 'unknown' && !issues.includes('evidence-unconfirmed')) issues.push('evidence-unconfirmed')

  const blockers = [...new Set([...strings(closure.blockers), ...strings(signoff.blockers)])]
  const warnings = [...new Set([...strings(closure.warnings), ...strings(signoff.warnings)])]
  // 签核状态：只在"有评估 + 证据当前 + 版本一致"时才可能给出就绪类结论。
  // 没有评估（closureAssessment/signoffPackage 缺失）一律 unknown —— 绝不用"零 blocker"推断就绪。
  const hasAssessment = Object.keys(closure).length > 0 || Object.keys(signoff).length > 0
  let status: VerificationWorkbenchSnapshot['signoff']['status'] = 'unknown'
  if (!hasAssessment) status = 'unknown'
  else if (evidenceStatus === 'stale' || evidenceStatus === 'missing' ||
    (versionCurrent && (closure.status === 'NOT_READY' || signoff.status === 'NOT_READY' || blockers.length > 0 || clauses.failed > 0))) status = 'not-ready'
  else if (evidenceStatus === 'current' && !issues.includes('mapping-incomplete') &&
    str(signoff.rtlHash) === currentRtlHash && strings(signoff.evidenceFiles).length > 0) {
    if (closure.status === 'CONDITIONALLY_READY' && signoff.status === 'CONDITIONALLY_READY') status = 'conditional'
    else if (closure.status === 'READY_FOR_HUMAN_SIGNOFF' && signoff.status === 'READY_FOR_HUMAN_SIGNOFF') status = 'review'
  }

  return {
    generatedAt: str(state.generatedAt), source, currentRtlHash, snapshotRtlHash, clauses, clauseDetails,
    evidence: { status: evidenceStatus, missing, stale },
    signoff: { status, blockers, warnings }, issues
  }
}
