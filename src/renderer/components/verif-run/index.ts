/**
 * 验证失败诊断与修复可视化（方案 C）组件桶导出。
 * 集成方一次导入：`import { VerifRunPanel, FixWindowBanner, RootCauseChainSection, DiagnosticTimelineSection, ... } from '../components/verif-run'`
 */

export * from './types.ts'
export { RunLoopCard, type RunLoopCardProps } from './RunLoopCard.tsx'
export { ProposedDecisionCard, DECISION_SOURCE_META, type ProposedDecisionCardProps } from './ProposedDecisionCard.tsx'
export { VerifRunPanel, type VerifRunPanelProps } from './VerifRunPanel.tsx'
export { FixWindowBanner, type FixWindowBannerProps } from './FixWindowBanner.tsx'
export { RootCauseChainSection, type RootCauseChainSectionProps } from './RootCauseChainSection.tsx'
export { DiagnosticTimelineSection, type DiagnosticTimelineSectionProps, type UtEscalationTimelineEvent } from './DiagnosticTimelineSection.tsx'
