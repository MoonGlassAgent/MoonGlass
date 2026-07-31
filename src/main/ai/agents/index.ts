/**
 * 7 阶段专用 Agent 定义（骨架）
 *
 * 每个阶段对应一个 Agent descriptor：绑定阶段提示词 ID 与可用工具集。
 * TODO(Phase 2): 接入 Pi Coding Agent（Python 子进程 + IPC）作为运行时；
 * TODO(Phase 2): 接入 LLM Provider 注册表（OpenAI / Anthropic / DeepSeek / Ollama）。
 */

import { PHASE_ORDER, type Phase } from '@shared/types'
import { PHASE_CONSTRAINTS } from '@moonglass/prompts'
import { CHIPFORGE_TOOL_NAMES } from '../tools/moonglass'

export interface AgentDescriptor {
  id: string
  phase: Phase
  /** 对应 @moonglass/prompts 中的阶段提示词模板 ID */
  promptTemplateId: string
  /** 该阶段 Agent 可调用的工具名清单 */
  toolNames: readonly string[]
  /** 展示名 */
  displayName: string
}

const PHASE_AGENT_META: Record<Phase, { displayName: string; tools: string[] }> = {
  REQ: { displayName: 'Requirements Analyst', tools: ['query_datasheet', 'execute_python'] },
  SPEC: { displayName: 'Specification Engineer', tools: ['extract_interface', 'query_datasheet', 'execute_python'] },
  ARCH: { displayName: 'Architect', tools: ['extract_interface', 'query_ip_library', 'execute_python'] },
  RTL: {
    displayName: 'RTL Engineer',
    tools: ['collect_rtl_files', 'read_verilog', 'generate_rtl_template', 'run_verible_lint', 'check_synthesizability', 'query_ip_library', 'query_company_rules', 'execute_python']
  },
  VERIF: {
    displayName: 'Verification Engineer',
    tools: ['collect_rtl_files', 'read_verilog', 'run_verible_lint', 'check_synthesizability', 'generate_tb', 'run_simulation', 'execute_python']
  },
  QA: {
    displayName: 'QA Engineer',
    tools: ['collect_rtl_files', 'run_verible_lint', 'run_cdc_check', 'check_synthesizability', 'query_company_rules', 'execute_python']
  },
  SYNTH: {
    displayName: 'Synthesis Engineer',
    tools: ['collect_rtl_files', 'check_synthesizability', 'generate_sdc', 'run_logic_synthesis', 'execute_python']
  }
}

export const PHASE_AGENTS: readonly AgentDescriptor[] = PHASE_ORDER.map((phase) => {
  const meta = PHASE_AGENT_META[phase]
  const tools = meta.tools.filter((t) => (CHIPFORGE_TOOL_NAMES as readonly string[]).includes(t))
  return {
    id: `mg-agent-${phase.toLowerCase()}`,
    phase,
    promptTemplateId: PHASE_CONSTRAINTS[phase].id,
    toolNames: tools,
    displayName: meta.displayName
  }
})

export function getAgentForPhase(phase: Phase): AgentDescriptor {
  const agent = PHASE_AGENTS.find((a) => a.phase === phase)
  if (!agent) throw new Error(`[agents] 未找到阶段 Agent: ${phase}`)
  return agent
}
