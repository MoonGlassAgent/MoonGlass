/**
 * 验证行动推导的渲染端薄壳。
 *
 * 纯推导内核已下沉至 @shared/verification-guidance（VERIF-RUN-LOOP 批 1，
 * 主进程运行循环与渲染端共用同一份实现，见 docs/VERIF-RUN-LOOP-DESIGN-ZH-CN.md §3.1）。
 * 本模块只负责注入 i18n 的 t()，保持原有调用签名不变，消费方无需感知 tr 参数。
 */
import { t } from './i18n/index.ts'
import {
  deriveTopRisks as deriveTopRisksCore,
  deriveVerificationActions as deriveVerificationActionsCore,
  deriveVerificationSteps as deriveVerificationStepsCore,
  topicExplanation as topicExplanationCore,
  type ExplainedRisk,
  type GuidanceRisk,
  type GuidanceState,
  type GuidanceTranslate,
  type VerificationAction,
  type VerificationStep
} from '@shared/verification-guidance'

/** 注入渲染端 i18n：GuidanceMessageKey 是 MessageKey 的子集，t 可直接适配 */
const tr: GuidanceTranslate = (key, params) => t(key, params)

export function deriveVerificationActions(state: GuidanceState): VerificationAction[] {
  return deriveVerificationActionsCore(state, tr)
}

export function deriveTopRisks(state: GuidanceState, risks: GuidanceRisk[]): ExplainedRisk[] {
  return deriveTopRisksCore(state, risks, tr)
}

export function deriveVerificationSteps(state: GuidanceState | null): VerificationStep[] {
  return deriveVerificationStepsCore(state, tr)
}

export function topicExplanation(topic: string): string {
  return topicExplanationCore(topic, tr)
}

export { CLOSED_VERIFICATION_STATUSES } from '@shared/verification-guidance'
export type {
  ExplainedRisk,
  GuidanceHole,
  GuidanceIntent,
  GuidanceMessageKey,
  GuidanceRisk,
  GuidanceState,
  GuidanceTranslate,
  RiskLevel,
  VerificationAction,
  VerificationStep
} from '@shared/verification-guidance'
