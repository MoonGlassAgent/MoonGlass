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
      description: 'Raise the budget limits here before resuming. Step/token counts keep accumulating from their current values (no reset); the wall clock re-opens from the moment you resume (unattended duration restarts). Limits not above the current consumption will be rejected.',
      confirm: 'Resume'
    },
    /** Amber consumption line at the top of the resume dialog (wall clock = elapsed time in the current window) */
    consumption: 'Current consumption: {beats} steps · {tokens} tokens · {minutes} min elapsed this window',
    /** Wall-clock preset chip label (values are minutes): {n}h */
    presetHours: '{n}h'
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
  }
}
