/**
 * 系统提示词组装器
 *
 * 组装顺序（依据规格书 §3.3）：
 *   1. 全局约束（最前）
 *   2. 阶段约束
 *   3. 项目级约束
 *   4. 用户自定义提示词
 *   5. 安全约束（最后）
 */

import type { Phase } from '@shared/types'
import {
  GLOBAL_CONSTRAINTS,
  PHASE_CONSTRAINTS,
  SECURITY_CONSTRAINTS,
  type PromptTemplate
} from './templates'

const SEPARATOR = '\n\n---\n\n'

export function buildSystemPrompt(
  phase: Phase,
  projectConstraints: PromptTemplate[] = [],
  userCustomPrompt?: string
): string {
  const parts: string[] = []

  // 1. 全局约束（最前）
  parts.push(GLOBAL_CONSTRAINTS.content)

  // 2. 阶段约束
  const phasePrompt = PHASE_CONSTRAINTS[phase]
  if (phasePrompt) parts.push(phasePrompt.content)

  // 3. 项目级约束
  for (const c of projectConstraints) {
    if (c.level === 'project') parts.push(c.content)
  }

  // 4. 用户自定义
  if (userCustomPrompt) parts.push(userCustomPrompt)

  // 5. 安全约束（最后）
  parts.push(SECURITY_CONSTRAINTS.content)

  return parts.join(SEPARATOR)
}
