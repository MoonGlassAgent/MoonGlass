import type { WorkspaceMessages } from '../zh-CN/workspace'

export const workspace: WorkspaceMessages = {
  notFound: 'Project not found or loading…',
  backToProjects: 'Back to Projects',
  currentPhase: 'Current phase: {phase} · {label}',
  startChange: 'New Change',
  generateDashboard: 'Generate Dashboard',
  generatingDashboard: 'Generating…',
  verificationPosture: 'Verification Posture',

  gate: {
    recheck: '🔄 Re-run Gate Checks',
    fixThenRecheck: 'Fix the issues, then re-run the checks',
    forcedNotice: '⚠️ Force-advanced; leftover issues are flagged with a red exclamation mark',
    passed: '✅ Gate passed; ready to advance'
  },

  managedDialog: {
    title: 'One-Click Managed Run',
    description: 'Automatically execute, fix gate failures, and advance from the current phase. Stops immediately when gate retries fail; never forces past them.',
    endPhase: 'Run Until',
    hint: 'Automatic decisions prefer recommended options and are recorded in the report. Formal sign-off, third-party licenses, and irreversible operations still require engineer review.',
    start: 'Start Managed Run',
    stop: 'Stop Managed Run'
  },

  managedRun: {
    running: 'Managed run in progress',
    lastRun: 'Last managed run',
    viewReport: 'View Managed Report'
  },

  changeDialog: {
    title: 'New Controlled Change',
    description: 'Keep existing work, create a change request, and start handling it from the earliest affected phase.',
    typeLabel: 'Change Type',
    typeRequirement: 'Requirement Change',
    typeSpecification: 'Specification Change',
    typeBug: 'Third-Party / Test Defect',
    sourcePhase: 'Starting Phase',
    descriptionLabel: 'Change / Defect Description',
    descriptionPlaceholder: 'Describe the symptom, expected behavior, affected interfaces, reproduction steps, or new specification...',
    submit: 'Create & Start'
  },

  changeKind: {
    requirement: 'requirement change',
    specification: 'specification change',
    bug: 'bug fix'
  },

  artifactDrift: {
    title: 'Phase Artifacts Out of Sync with Records',
    description: 'The database marks the phases below as completed, but their artifact directories no longer exist on disk. Choose how to proceed.',
    entryHint: 'Recorded as completed, but the artifact directories no longer exist: {paths}',
    resetDownstream: 'Also reset records of completed downstream phases (QA/SYNTH conclusions were built on deleted evidence)',
    keepHint: 'After keeping the current state, you can use the "purge & reset" action on the phase board hover menu at any time; if you plan to restore the artifacts yourself, just continue in the original Agent session.',
    startOver: 'Start from Scratch',
    purging: 'Purging…',
    keep: 'Keep as Is',
    progress: 'Purging drifted phase records ({index}/{total})…'
  },

  verifBar: {
    statusLabel: 'VERIF Status:',
    refresh: 'Refresh VERIF status',
    current: 'Current: {label}',
    next: 'Next: {action}',
    defaultNextAction: 'Generate AIGV verification plan',
    planEnv: '① Plan & Env',
    planEnvTitle: 'Intent registration + environment bring-up + smoke acceptance (W0)',
    basic: '② Basic Functions',
    basicTitle: 'Close spec-mapping clauses one by one (W1)',
    corner: '③ Corner Waves',
    cornerTitle: 'Run corner scenarios by topic wave (W2)',
    signoff: '④ Sign-off',
    signoffTitle: 'Coverage / Formal / Mutation / residual-risk approval (W3)',
    expertActions: 'Expert Actions',
    expertActionsHint: 'Manually advance verification by wave (for users familiar with the wave methodology); following the primary action is usually enough'
  },

  synthBar: {
    label: 'Synthesis:',
    run: '⚙ Generate SDC & Run Synthesis',
    agentRunning: 'Agent running…'
  },

  tabs: {
    chat: '💬 Chat',
    verifRun: '🔬 Verification Runs'
  },

  viewer: {
    lineCount: '{count} lines · read-only',
    findTitle: 'Find (Ctrl+F)',
    findAria: 'Find in file',
    source: 'Source',
    preview: 'Preview',
    reload: 'Reload file',
    wordWrapTitle: 'Toggle word wrap',
    wordWrap: 'Word Wrap',
    decreaseFont: 'Decrease font size',
    increaseFont: 'Increase font size',
    openExternal: '🌐 Open Externally',
    truncated: '(Content too large; showing first 256 KB only)',
    unreadable: '(Unable to read this file)'
  },

  statusBar: {
    toolchain: 'Toolchain: {toolchain}',
    phases: 'Phases: {done}/{total}',
    footer: 'MoonGlass v{version} · Six-Phase ASIC Flow'
  },

  confirm: {
    gateBlocked: 'Gate checks not fully passed ({count} Error-level checks failed).\n\nContinue advancing to {phase} anyway?\nFailed checks remain as known issues flagged with a red exclamation mark.',
    rollback: 'Rolling back to {phase} marks later-phase outputs as obsolete. Confirm rollback?',
    enterDuringManaged: 'A managed run is in progress and depends on the phase order; switching phases manually may break the orchestration. Switch anyway?',
    manualTakeover: 'The autonomous verification loop is running.\n\nPause it and execute this action manually instead?',
    resetNoArtifacts: '  - No phase artifacts',
    resetArchive: 'Archive & Restart',
    resetPurge: 'Permanently Delete',
    resetPhase: '{action} "{phase}"?\n\n{count} files ({size} MB) will be processed:\n{paths}\n\n{purgeNote}Upstream results are kept; completed downstream phases get a yellow change notice.',
    resetPurgeNote: 'The phase session history will also be deleted; the phase will not restart automatically — start it via chat or a managed run.\n',
    resetPurgeConfirm: 'This permanently deletes the artifacts and cannot be undone. Confirm permanent deletion?',
    fastTrack: 'This skips verification and QA checks and goes straight to synthesis.\n\nThis path is only for quick area estimation; synthesis results are not evidence of functional verification, quality sign-off, or release readiness. Continue?',
    completeProject: 'Confirm synthesis is complete and mark the project as done?'
  },

  log: {
    waveformOpened: 'Opened with GTKWave: {path}',
    waveformOpenFailed: 'Failed to open waveform: {error}',
    cannotOpenExternal: '⚠️ {path} cannot be opened externally',
    openedExternal: '🌐 Opened: {path}',
    fileOpenFailed: 'Failed to open file: {path}: {error}',
    advanceFailed: 'Phase advance failed: {error}',
    forceAdvanced: '⚠️ User confirmed force-advancing to {phase} with failing gate checks',
    rechecking: '🔄 Re-running gate checks...',
    gateFailed: '❌ Gate not passed',
    gateCheckDone: '✅ Gate checks complete',
    gateCheckFailed: '❌ Gate check failed: {error}',
    enteredPhase: 'Entered {phase}; later-phase artifacts kept',
    enterPhaseFailed: 'Failed to enter phase: {error}',
    respondChangeStart: 'Responding to change impact on {phase}',
    respondChangeDone: '✅ Change response for {phase} complete',
    respondChangeFailed: 'Change response failed: {error}',
    gateIssuesSent: 'Sent {count} gate issues to the Agent session',
    gateFixSendFailed: 'Failed to send gate-fix instruction: {error}',
    planEnvStart: 'Starting verification planning & environment bring-up (W0)...',
    planEnvDone: 'Verification planning & environment bring-up complete',
    commandSendFailed: 'Failed to send instruction: {error}',
    basicStart: 'Starting W1 basic functional verification...',
    basicDone: 'Basic functional verification complete',
    cornerStart: 'Starting W2 corner waves...',
    cornerDone: 'Corner-wave verification complete',
    signoffStart: 'Starting W3 sign-off...',
    signoffDone: 'Sign-off complete',
    phaseResetFailed: 'Phase operation failed: {error}',
    driftPurging: 'Artifact drift detected: purging records of {phase} ({index}/{total})…',
    driftPurged: 'Started from scratch: purged records and sessions of {count} drifted phase(s)',
    archived: 'Archived {count} files of {phase} to {path}; restarted with a clean session',
    purged: 'Permanently deleted {count} files of {phase} and its session; not restarted',
    dashboardGenerated: 'Dashboard generated: {path}',
    dashboardNotOpened: 'The dashboard could not be opened automatically; open docs/07_release/project_dashboard.html from the file tree',
    dashboardFailed: 'Dashboard generation failed: {error}',
    guidanceActionSent: 'Handed the posture-recommended action to the main Agent…',
    guidanceActionDone: 'Recommended action complete; refresh VERIF status or Verification Posture',
    guidanceActionFailed: 'Recommended action failed: {error}',
    managedRetry: 'Managed run: Agent error, retry {attempt}/3: {error}',
    managedDecisionSendFailed: 'Managed run: failed to send auto-decision, retry {attempt}/3: {error}',
    managedTaskSessionFailed: 'Managed run: failed to start task session, continuing in the current session: {error}',
    managedChangeFailed: 'Managed run: change response for {phase} failed, risk recorded, continuing: {error}',
    managedRunLoopStarted: 'Managed run: verification run loop started (default budgets); waiting for a terminal or paused state…',
    managedRunLoopCompleted: 'Managed run: verification run loop completed ({beats} steps); continuing to gate / QA',
    managedRunLoopHalted: 'Managed run: verification run loop halted at "{state}" ({reason}); managed run stopped. Go to the "Verification Runs" tab to handle it, then resume the loop and advance manually',
    managedRunLoopStopFailed: 'Failed to stop the verification run loop: {error}',
    runLoopStarted: 'Verification run loop started',
    runLoopPauseFailed: 'Failed to pause the verification run loop: {error} (continuing the manual action anyway)',
    managedAgentFailed: 'Managed run: Agent error in {phase}, risk recorded, continuing to gate checks: {error}',
    managedGateCarried: 'Managed run: {phase} gate still has {count} blockers; marked unsigned and advancing',
    managedGateRecoveryFailed: 'Managed run: gate-recovery Agent error, continuing to the next round: {error}',
    managedFinished: '{result}; report: {path}',
    managedCompleted: 'Managed run fully passed',
    managedCompletedWithRisk: 'Managed run completed with {count} risks (unsigned)',
    managedPaused: 'Managed run paused',
    changeCreated: 'Created {kind} {id}; entered {phase}',
    synthesisStart: '⚙ Starting logic synthesis...',
    synthesisDone: 'Synthesis evaluation complete',
    synthesisSendFailed: '❌ Failed to send synthesis instruction: {error}'
  }
}
