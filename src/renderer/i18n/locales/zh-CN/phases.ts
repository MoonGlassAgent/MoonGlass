import type { Phase } from '@shared/types'

/** 六阶段界面显示名（取值与 shared/types/moonglass.ts 的 PHASE_LABELS 对齐） */

export const phases: Record<Phase, string> = {
  REQ_SPEC: '需求-规格定义',
  ARCH: '架构设计',
  RTL: 'RTL 开发',
  VERIF: '验证完备',
  QA: '质量检查',
  SYNTH: '综合实现'
}

export type PhaseMessages = typeof phases
