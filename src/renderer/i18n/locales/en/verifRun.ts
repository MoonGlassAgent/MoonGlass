import type { Messages } from '../zh-CN/index.ts'

/**
 * 验证运行中心（VerifRunPanel / 根因链 / 诊断时间线）文案（英文）。
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
