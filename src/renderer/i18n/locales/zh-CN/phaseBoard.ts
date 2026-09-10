/** 阶段看板（PhaseBoard）文案：阶段节点提示、推进/回退按钮、门禁检查结果面板 */

export const phaseBoard = {
  nodeTitle: '{phase} — {status}\n交付物: {count} 项\n双击进入阶段',
  backgroundRunningTitle: '{phase}阶段的 Agent 仍在后台运行，双击进入该阶段可查看进度',
  backgroundRunningAria: '{phase}后台运行中',
  changePendingAria: '{phase}有来自{source}的变更待响应',
  changePendingTitle: '来自{source}的变更待响应：{reason}',
  issuesAria: '{phase}有 {count} 项遗留问题',
  issuesTitle: '{phase}遗留问题（{count}）',
  issuesHint: '浮层内文字可选择；点击感叹号可保持显示。',
  fixInChat: '在会话中修复',
  resetArchiveTitle: '归档本阶段产物并重新开始',
  resetArchiveAria: '归档重做',
  resetPurgeTitle: '彻底清除本阶段产物（不自动重新开始）',
  resetPurgeAria: '彻底清除',
  advanceTo: '推进到 {phase} →',
  rollbackTo: '← 回退到 {phase}',
  fastTrackSynthesis: '跳过 VERIF/QA，快速评估面积',
  completeProject: '完成综合并结束项目',
  projectCompleted: '项目已完成',
  gateBlocked: '门禁未通过，已阻止推进。修复后请重试；也可再次点击“推进”按钮并确认强制推进。',
  gateForced: '门禁未完全通过，已由用户确认强制推进；以下问题保留为遗留事项（红色感叹号）。',
  gateAllowed: '已允许推进，以下问题已记录为遗留事项。'
}

export type PhaseBoardMessages = typeof phaseBoard
