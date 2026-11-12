import type { BoardMessages } from '../zh-CN/board'

export const board: BoardMessages = {
  title: 'Flow Board',
  subtitle: 'Phase → task → attempt facts (read-only view)',
  navWorkspace: 'Back to Workspace',
  refresh: 'Refresh',
  reload: 'Reload',
  updatedAt: 'Ledgers updated: {time}',
  taskCount: '{count} tasks',
  attemptCount: '{count} attempts',
  columnEmpty: 'No tasks in this phase yet',
  status: {
    success: 'Success',
    running: 'Running',
    needsFix: 'Needs Fix',
    pendingHuman: 'Pending Human',
    notStarted: 'Not Started'
  },
  kind: {
    batch: 'Verify Batch',
    rtlFix: 'RTL Fix',
    designReview: 'Design Review',
    moduleUt: 'Module UT',
    decision: 'Decision Proposal',
    runLoop: 'Run Loop'
  },
  verdict: {
    success: 'Success',
    failed: 'Failed',
    noEvidence: 'No Evidence',
    circuitBroken: 'Circuit Broken',
    error: 'Error',
    running: 'Running'
  },
  attempts: {
    title: 'Attempts',
    indexLabel: 'Attempt {index}',
    empty: 'No attempts yet',
    colModel: 'Model',
    colVerdict: 'Verdict',
    colStartedAt: 'Started',
    colSettledAt: 'Settled',
    colDuration: 'Duration',
    colNote: 'Note',
    unknownModel: 'Unregistered',
    durationMinutes: '{minutes}m {seconds}s',
    durationSeconds: '{seconds}s'
  },
  pendingHuman: 'Pending human action',
  loading: 'Loading…',
  empty: {
    title: 'No flow tasks yet',
    hint: 'This project has no batch / fix / review / UT / decision task records yet. They will appear here once created.'
  },
  error: {
    title: 'Failed to load the board',
    hint: 'Error reading flow ledgers: {message}'
  }
}
