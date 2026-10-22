import type { Messages } from '../zh-CN/index.ts'

/**
 * 验证运行中心（VerifRunPanel / 根因链 / 诊断时间线）文案（英文）。
 *
 * Terminology: a loop "step" is one full round of read posture → derive action →
 * dispatch → judge result. The ledger field is still named `beat`; the UI says
 * "step". One step is not one unit of work: a batch-loop step may contain several
 * batches (up to 20 by default).
 */
export const verifRun: Messages['verifRun'] = {
  tabTitle: 'Verification Runs',
  batch: {
    title: 'Batch Orchestration',
    empty: 'No batch orchestration started yet',
    startBasic: 'Start Basic Verification',
    state: {
      idle: 'Idle',
      running: 'Running',
      'awaiting-rtl-fix': 'Awaiting RTL fix',
      'circuit-broken': 'Circuit broken',
      completed: 'Completed',
      stopped: 'Stopped'
    },
    currentBatch: 'Batch {index}',
    phaseDispatched: 'Dispatched',
    phaseSettling: 'Judging',
    dispatchedAt: 'Dispatched at {time}',
    waitingFix: 'Awaiting fix {rootCauseId} (since {time})',
    breakerTitle: 'Circuit-breaker reason',
    continueInChat: 'Continue in chat',
    historyTitle: 'Completed batches (this loop)',
    verdictCompleted: 'Completed',
    verdictCircuitBroken: 'Circuit broken',
    legacyNoLabels: 'This batch entry predates scenario title snapshots, so only scenario IDs are available; run a new batch to see what is being verified',
    scenarioUntitled: '(no title snapshot)',
    updatedAt: 'Updated at {time}'
  },
  loop: {
    title: 'Autonomous Verification Loop',
    empty: 'Autonomous verification loop not started yet',
    wave: 'Wave {wave}',
    waveNone: 'Wave —',
    beat: 'Step {n}',
    currentTitle: 'Current action',
    noCurrent: 'No action dispatched this step',
    sessionLabel: 'Session {name}',
    state: {
      idle: 'Idle',
      planning: 'Planning',
      running: 'Running',
      judging: 'Judging',
      repairing: 'Repairing',
      'paused-human': 'Awaiting human',
      'paused-breaker': 'Circuit broken',
      'signoff-review': 'Sign-off review',
      'gate-check': 'Gate check',
      completed: 'Completed',
      stopped: 'Stopped'
    },
    source: {
      rule: 'Rule',
      llm: 'LLM',
      human: 'Human'
    },
    beatsBudget: 'Loop steps',
    tokensBudget: 'Tokens',
    wallBudget: 'Wall clock',
    minutesSuffix: ' min',
    pauseHumanTitle: 'Awaiting human input',
    pauseBreakerTitle: 'Circuit broken',
    pauseSince: 'Since {time}',
    pendingTitle: 'Pending items',
    beatsTitle: 'Recent steps (newest first; green = advanced)',
    decisionsTitle: 'Decisions',
    proposedEmpty: 'No pending decision proposals',
    /** Subtitle hint for the loop decision section pinned at the bottom of the chat */
    proposedHint: '(Loop paused for human input: resumes on approval; rejection trips the breaker)',
    rationaleLabel: 'Rationale',
    promptLabel: 'Action prompt',
    expectedLabel: 'Expected output',
    stopCriteriaLabel: 'Stop criteria',
    evidenceCount: '{count} evidence refs',
    approve: 'Approve',
    reject: 'Reject',
    deciding: 'Submitting…',
    historyTitle: 'Decision history ({count})',
    outcome: {
      advanced: 'Advanced',
      'no-progress': 'No progress',
      failed: 'Failed',
      none: 'Not recorded'
    },
    start: 'Start Autonomous Verification',
    /** Re-entry from a terminal state (stopped/completed): start a new loop, prefilled with the previous budget */
    restart: 'Restart loop',
    pause: 'Pause',
    resume: 'Resume',
    stop: 'Stop',
    actionFailed: 'Action failed: {error}',
    /** Escape hatch for the "already running" start error (stale handle): stop then restart */
    forceRestart: 'Force stop & restart',
    startDialog: {
      title: 'Start Autonomous Verification Loop',
      description: 'The loop derives and executes verification actions step by step (planning / batches / fixes / sign-off / gate), pausing structurally when human input is needed and resuming once answered. Budgets are hard guardrails for unattended runs; exceeding them trips the circuit breaker.',
      maxBeats: 'Max loop steps',
      maxBeatsHint: 'How many steps the loop may execute automatically; each step is one verification action dispatch (a batch-loop step may contain several batches). Default 50.',
      maxTokens: 'Max tokens',
      maxTokensHint: 'Cumulative token budget for this loop (default 5,000,000)',
      maxWallMinutes: 'Max wall clock (minutes)',
      maxWallMinutesHint: 'Longest total runtime of the loop (default 240 min)',
      noProgressLimit: 'No-progress limit (steps)',
      noProgressLimitHint: 'Consecutive steps without progress before the breaker trips (default 3)',
      confirm: 'Start'
    },
    resumeDialog: {
      title: 'Resume Autonomous Verification Loop',
      description: 'Raise the budget limits here before resuming. Resuming manually is an attended gesture: step/token/wall-clock counters reset to zero and a fresh window opens from the moment you resume (unattended duration restarts).',
      confirm: 'Resume'
    },
    /** Amber consumption line at the top of the resume dialog (wall clock = elapsed time in the current window) */
    consumption: 'Current consumption: {beats} steps · {tokens} tokens · {minutes} min elapsed this window',
    /** Wall-clock preset chip label (values are minutes): {n}h */
    presetHours: '{n}h',
    /** Strategic-layer summary (one number + one line): closure rate, machine-generated headline, amber budget warning */
    summary: {
      /** Blocked: pending-human one-liner takes precedence */
      blocked: '{wave} · {summary}',
      /** Warming up: no forecast or no rate data */
      warmup: '{wave} · Warming up, no rate data yet',
      /** Warning (binding=insufficient): budget runs out at ~{projected} clauses */
      insufficient: '{wave} · At the current pace {covered}/{total}, the budget only reaches ~{projected} clauses — action suggested (raise budget or change strategy)',
      /** Strategy: switched to "{strategy}"{reason} (reason includes a leading colon) */
      strategy: '{wave} · Switched to "{strategy}"{reason}',
      /** Normal: progress + ETA range + budget binding text */
      normalWithEta: '{wave} · {progress}, ~{low}–{high} hours to go at the current rate, budget {binding}',
      /** Normal: fallback when the forecast has no ETA detail (missing-data normalization) */
      normalNoEta: '{wave} · {progress}, budget {binding}',
      progressEarly: 'In progress {covered}/{total}',
      progressHalf: 'Past halfway {covered}/{total}',
      progressDone: 'Target met {covered}/{total}',
      /** Qualitative progress word when no coverage data */
      progressNoData: 'In progress',
      bindingSufficient: 'sufficient',
      bindingTight: 'tight',
      bindingInsufficient: 'insufficient',
      bindingUnknown: 'unknown',
      strategyNameNormal: 'Normal pace',
      strategyNameConvergeFirst: 'Converge first',
      strategyNameDeepDive: 'Deep dive',
      strategyNameSteadyRegression: 'Steady regression',
      strategyReasonConvergeFirst: ': closing {count} open closure items before speeding up',
      strategyReasonDeepDive: ': focusing on {count} unclosed scenarios',
      strategyReasonSteadyRegression: ': consolidating existing passes via regression first',
      /** Attached when confidence=low: forecast for reference only */
      forecastNote: '(Rate sample too small; forecast for reference only)',
      /** The one number: closure rate (sole permanent hard metric) */
      coverage: 'Verified {covered}/{total}',
      /** Closure rate + stale-pass disclosure */
      coverageStale: 'Verified {covered}/{total}, incl. {stale} awaiting regression',
      coverageNone: 'No coverage data yet',
      /** Placeholder when the wave is missing */
      waveUnknown: '—',
      /** Amber budget warning: dimension names */
      dimSteps: 'Loop steps',
      dimTokens: 'Tokens',
      dimWall: 'Wall clock',
      /** Amber budget warning: expected to hold / fall short (decided via forecast.binding) */
      budgetEnough: 'expected to hold',
      budgetShort: 'expected to fall short',
      budgetWarning: '{dimension} budget {percent}% used ({used}/{max}), {verdict}'
    }
  },
  fix: {
    title: 'RTL Fix',
    empty: 'No fix records yet',
    stateFixing: 'Fixing',
    judgment: {
      FIXED: 'Fixed',
      STILL_FAIL: 'Still failing',
      UNKNOWN: 'Unknown'
    },
    recordMissing: 'Matching root-cause record not found',
    startedAt: 'Started at {time}',
    settledAt: 'Judged at {time}',
    continueDiagnosis: 'Continue diagnosis',
    rerunRegression: 'Re-run regression',
    auditToggle: 'Audit diff & interceptions',
    auditMissing: 'Audit file not loaded yet',
    noFileChanges: 'No file changes in this window',
    auditChanged: 'Modified',
    auditCreated: 'Created',
    auditDeleted: 'Deleted',
    blockedAttempts: '{count} write-protect interceptions',
    unknownReason: 'Regression not re-run after fix'
  },
  window: {
    banner: 'RTL fix in progress (root cause {rootCauseId} / scenario {scenarioId}); rtl/ is write-protected during the fix window.',
    since: 'Fix started at {time}'
  },
  rootCause: {
    title: 'Root-Cause Chain',
    empty: 'No root-cause records yet',
    count: '{count} records',
    verdict: {
      open: 'Open',
      refuted: 'Refuted',
      confirmed: 'Confirmed'
    },
    refutedBy: 'Refuted {ids}',
    fixLabel: 'Fix: {fix}',
    recordedAt: 'Recorded at {time}'
  },
  diagnostic: {
    title: 'Diagnostic Ledger',
    empty: 'No diagnostic attempts yet',
    timelineTitle: 'Diagnostic Timeline',
    attemptCount: '{count} attempts',
    fingerprint: 'Failure signature {signature}',
    sameFingerprint: '{count} attempts with same signature',
    enhancementEntered: 'Enhanced diagnosis entered',
    triggerSameFingerprint: 'Trigger: same-signature failures ≥ 2',
    triggerStalled: 'Trigger: ≥ 3 attempts without level escalation',
    ladderTitle: 'Diagnostic level escalation (L0 → L5)',
    level: 'L{level}',
    passed: 'PASS',
    failed: 'FAIL',
    duration: '{ms} ms',
    colTime: 'Time',
    colTestcase: 'Testcase',
    colResult: 'Result',
    colLevel: 'Level',
    colDuration: 'Duration',
    colEvidence: 'Evidence',
    openEvidence: 'Open evidence file',
    utEscalationsTitle: 'UT Escalations ({count})',
    utEscalationActive: 'active',
    utEscalationRetired: 'Retired',
    utEscalationRootCause: 'Related root cause record'
  },
  ut: {
    title: 'Module UT',
    start: 'Start Module UT',
    activeBadge: 'UT running ×{count}',
    activeLine: 'Module UT running ({count}): {modules} — main loop mutually suspended',
    activeNoNames: 'Module UT running ({count}) — main loop mutually suspended',
    idleHint: 'Launch an isolated UT session for an RTL submodule: minimal env, fast iteration (probe-isolated, not part of the main evidence chain).',
    dialogTitle: 'Start Module UT',
    modulePlaceholder: 'Type or pick a module name under rtl/',
    confirm: 'Start',
    starting: 'Dispatching…',
    emptyModule: 'Please enter a module name',
  }
}
