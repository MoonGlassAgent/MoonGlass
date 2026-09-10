import type { PhaseBoardMessages } from '../zh-CN/phaseBoard'

export const phaseBoard: PhaseBoardMessages = {
  nodeTitle: '{phase} — {status}\nDeliverables: {count}\nDouble-click to enter phase',
  backgroundRunningTitle: 'The {phase} phase agent is still running in the background; double-click to enter and view progress',
  backgroundRunningAria: '{phase} running in background',
  changePendingAria: '{phase} has a pending change from {source}',
  changePendingTitle: 'Pending change from {source}: {reason}',
  issuesAria: '{phase} has {count} unresolved issues',
  issuesTitle: '{phase} unresolved issues ({count})',
  issuesHint: 'Text in this popover is selectable; click the exclamation mark to keep it visible.',
  fixInChat: 'Fix in Chat',
  resetArchiveTitle: 'Archive phase deliverables and start over',
  resetArchiveAria: 'Archive and redo',
  resetPurgeTitle: 'Purge phase deliverables (does not restart automatically)',
  resetPurgeAria: 'Purge',
  advanceTo: 'Advance to {phase} →',
  rollbackTo: '← Roll back to {phase}',
  fastTrackSynthesis: 'Skip VERIF/QA for a quick area estimate',
  completeProject: 'Complete Synthesis and Finish Project',
  projectCompleted: 'Project completed',
  gateBlocked: 'Gate checks failed; advance was blocked. Fix the issues and retry, or click "Advance" again and confirm a forced advance.',
  gateForced: 'Gate checks did not fully pass; the user confirmed a forced advance. The following issues remain as leftovers (red exclamation mark).',
  gateAllowed: 'Advance allowed; the following issues have been recorded as leftovers.'
}
