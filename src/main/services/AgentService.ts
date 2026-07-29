/**
 * Agent 会话服务（Phase 2）
 *
 * 以 RPC 模式嵌入真实 Pi Coding Agent（@earendil-works/pi-coding-agent）：
 * 每个项目一个 pi 子进程（`pi --mode rpc`），cwd 为项目工作目录，
 * 系统提示词经 `.pi/APPEND_SYSTEM.md` 注入（buildSystemPrompt 按阶段组装），
 * Provider 配置经桥接扩展 + MOONGLASS_PROVIDERS_JSON 环境变量注入。
 *
 * 会话模型：项目唯一会话文件 session.jsonl —— 阶段推进/回退、关闭重开都延续
 * 同一份对话历史；阶段切换需秒级重启进程（系统提示词仅启动时读取），但会话
 * 文件不变、对话无缝连续。用户可主动「新会话」（resetSession）放弃继承。
 *
 * TODO(Phase 4): 芯片工具集以 pi 扩展注册；按阶段限制工具白名单
 *                （当前使用 pi 默认的 read/write/edit/bash 四工具，不做限制）。
 * TODO(打包): electron-builder 打包时需把 pi 依赖与桥接扩展纳入 extraResources。
 */

import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildSystemPrompt } from '@moonglass/prompts'
import type { AgentSessionInfo, AgentStreamEvent, AgentUiMessage, Phase } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'
import type { ProjectService } from './ProjectService'
import type { LlmProviderService } from './LlmProviderService'
import type { AgentModelStore } from './AgentModelStore'
import { PiRpcClient } from '../ai/runtime/pi/PiRpcClient'

/** 从 __dirname 向上探测 node_modules 中 pi 的 cli.js（纯 ESM 包无法走 require.resolve） */
function resolvePiBin(): string {
  const rel = join('node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  console.error('[agent-service] 未找到 pi-coding-agent 的 cli.js，Agent 功能不可用')
  return ''
}

interface PiSession {
  client: PiRpcClient
  projectId: string
  phase: Phase
  modelLabel: string
  selectedModel: { providerId: string; modelId: string } | null
  /** 进程启动时的 Provider 配置指纹（见 providersFingerprint） */
  fingerprint: string
}

/** pi 消息（仅声明映射所需的最小形状） */
interface PiMessage {
  role: string
  content?: unknown
  toolName?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
  command?: string
  output?: string
  timestamp?: number
}

const TOOL_OUTPUT_MAX = 2000

export class AgentService implements MoonGlassService {
  readonly name = 'agent-service'

  private sessions = new Map<string, PiSession>()
  private piBinPath = ''
  private bridgeDir = ''
  private emit: (projectId: string, event: AgentStreamEvent) => void = () => {}

  constructor(
    private readonly projects: ProjectService,
    private readonly llm: LlmProviderService,
    private readonly modelStore: AgentModelStore
  ) {}

  start(): void {
    // 注：pi-coding-agent 是纯 ESM 包（exports 仅声明 import 条件，且不含 ./package.json），
    // CJS 的 require.resolve 无法命中，改为从 __dirname 向上探测 node_modules 实体路径。
    this.piBinPath = resolvePiBin()

    // 桥接扩展复制到 userData（pi 经 -e 加载；仓库内原件在 resources/moonglass/pi-bridge/）
    this.bridgeDir = join(app.getPath('userData'), 'moonglass', 'pi-bridge')
    mkdirSync(this.bridgeDir, { recursive: true })
    const src = join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', 'moonglass-providers.ts')
    if (existsSync(src)) copyFileSync(src, join(this.bridgeDir, 'moonglass-providers.ts'))
    else console.error('[agent-service] 未找到桥接扩展源文件:', src)
  }

  stop(): void {
    for (const session of this.sessions.values()) session.client.dispose()
    this.sessions.clear()
  }

  /** 由主进程入口注入事件推送通道（webContents.send） */
  attachEmitter(emit: (projectId: string, event: AgentStreamEvent) => void): void {
    this.emit = emit
  }

  /** 已启用且配置了 Key、且有可用模型的 Provider */
  private readyProviders() {
    return this.llm.list().filter((p) => p.enabled && p.apiKey.trim().length > 0 && p.models.length > 0)
  }

  /**
   * Provider 配置指纹。pi 进程的 Provider 注册表在启动时经环境变量固化，
   * 配置变更（Key 轮换、模型增删）后必须重启进程才能生效。
   */
  private providersFingerprint(): string {
    return JSON.stringify(
      this.readyProviders().map((p) => [p.id, p.baseUrl, p.apiKey, p.models])
    )
  }

  private workspaceDir(projectId: string): string {
    return join(app.getPath('userData'), 'moonglass', 'workspaces', projectId)
  }

  /**
   * 项目唯一会话文件：阶段推进/回退、关闭重开都复用同一份对话历史，
   * 除非用户主动「新会话」（见 resetSession）。
   * pi --session 支持绝对路径，文件不存在时会自动创建。
   */
  private sessionFilePath(projectId: string): string {
    const dir = join(app.getPath('userData'), 'moonglass', 'pi-sessions', projectId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    // 迁移：v0.2 增量版曾按阶段分文件（<PHASE>.jsonl），首次切换时继承当前阶段的历史
    if (!existsSync(file)) {
      const project = this.projects.get(projectId)
      const legacy = project ? join(dir, `${project.currentPhase}.jsonl`) : ''
      if (legacy && existsSync(legacy)) copyFileSync(legacy, file)
    }
    return file
  }

  private writeSystemPrompt(projectId: string, phase: Phase): void {
    const dir = join(this.workspaceDir(projectId), '.pi')
    mkdirSync(dir, { recursive: true })
    // TODO(Phase 3 后续): 传入项目级约束与用户自定义提示词
    writeFileSync(join(dir, 'APPEND_SYSTEM.md'), buildSystemPrompt(phase), 'utf-8')
  }

  private spawnSession(projectId: string, phase: Phase, projectName: string): PiSession {
    if (!this.piBinPath) throw new Error('[agent-service] pi-coding-agent 不可用（依赖未安装？）')
    const workspace = this.workspaceDir(projectId)
    mkdirSync(workspace, { recursive: true })
    this.writeSystemPrompt(projectId, phase)

    const providers = this.readyProviders()
    const sessionFile = this.sessionFilePath(projectId)
    const client = new PiRpcClient({
      binPath: this.piBinPath,
      args: [
        '--mode', 'rpc',
        '-a', // 信任项目目录（.pi/APPEND_SYSTEM.md 生效的前提）
        '--session', sessionFile,
        '--name', `${projectName} / ${phase}`,
        '-e', join(this.bridgeDir, 'moonglass-providers.ts')
      ],
      cwd: workspace,
      env: {
        MOONGLASS_PROVIDERS_JSON: JSON.stringify(providers),
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        // 主进程 process.execPath 是 Electron 二进制；缺此变量时子进程不执行脚本直接退出
        ELECTRON_RUN_AS_NODE: '1'
      },
      onEvent: (event) => this.handlePiEvent(projectId, event),
      onExit: (code, stderrTail) => {
        // 防止旧进程异步退出时误删已重建的新会话
        const current = this.sessions.get(projectId)
        if (current === session) {
          this.sessions.delete(projectId)
          this.emit(projectId, {
            type: 'error',
            message: `pi 进程退出 (code=${code})${stderrTail ? `\n${stderrTail.slice(-500)}` : ''}`
          })
        }
      }
    })
    client.start()

    const session: PiSession = {
      client,
      projectId,
      phase,
      modelLabel: '',
      selectedModel: null,
      fingerprint: this.providersFingerprint()
    }
    this.sessions.set(projectId, session)
    return session
  }

  async ensureSession(projectId: string): Promise<AgentSessionInfo> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`[agent-service] 项目不存在: ${projectId}`)

    const providers = this.readyProviders()
    if (providers.length === 0) {
      return {
        projectId,
        phase: project.currentPhase,
        isStreaming: false,
        modelLabel: '',
        selectedModel: null,
        providersReady: false
      }
    }

    const fingerprint = this.providersFingerprint()
    let session = this.sessions.get(projectId)

    // Provider 配置变更或阶段变化都需要重启 pi 进程（两者都只能在进程启动时生效：
    // Provider 注册表经环境变量固化，阶段系统提示词仅在启动时读取）。
    // 注意：会话文件是项目唯一的 session.jsonl，进程重启后对话历史无缝延续。
    if (session && (session.fingerprint !== fingerprint || session.phase !== project.currentPhase)) {
      session.client.dispose()
      this.sessions.delete(projectId)
      session = undefined
    }

    if (!session) {
      session = this.spawnSession(projectId, project.currentPhase, project.name)
      await session.client.waitReady()

      // 优先恢复上次选中的模型；失效则回退到第一个可用 Provider 的第一个模型
      const selection = this.modelStore.get(projectId)
      const initial =
        selection && providers.some((p) => p.id === selection.providerId && p.models.includes(selection.modelId))
          ? selection
          : { providerId: providers[0].id, modelId: providers[0].models[0] }

      await session.client.command({ type: 'set_model', provider: initial.providerId, modelId: initial.modelId })
      session.modelLabel = `${initial.providerId} / ${initial.modelId}`
      session.selectedModel = initial
    }

    const state = await session.client
      .command<{ isStreaming?: boolean }>({ type: 'get_state' })
      .catch(() => ({ isStreaming: false }))

    return {
      projectId,
      phase: session.phase,
      isStreaming: state.isStreaming ?? false,
      modelLabel: session.modelLabel,
      selectedModel: session.selectedModel,
      providersReady: true
    }
  }

  async prompt(projectId: string, text: string): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session) throw new Error('[agent-service] 会话未建立，请先 ensureSession')
    await session.client.command({ type: 'prompt', message: text })
  }

  /**
   * 新会话（用户主动选择不继承原对话）：
   * 停掉当前进程、把现有会话文件归档为 session.bak.jsonl（覆盖旧备份），
   * 然后按当前阶段重建全新会话。
   */
  async resetSession(projectId: string): Promise<AgentSessionInfo> {
    const session = this.sessions.get(projectId)
    if (session) {
      session.client.dispose()
      this.sessions.delete(projectId)
    }
    const file = this.sessionFilePath(projectId)
    if (existsSync(file)) {
      copyFileSync(file, file.replace('session.jsonl', 'session.bak.jsonl'))
      // 归档后删除原文件，下次 spawn 时 pi 自动创建全新会话
      rmSync(file)
    }
    return this.ensureSession(projectId)
  }

  async abort(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session) return
    await session.client.command({ type: 'abort' }).catch(() => undefined)
  }

  async setModel(projectId: string, providerId: string, modelId: string): Promise<AgentSessionInfo> {
    const session = this.sessions.get(projectId)
    if (!session) throw new Error('[agent-service] 会话未建立，请先 ensureSession')
    await session.client.command({ type: 'set_model', provider: providerId, modelId })
    session.modelLabel = `${providerId} / ${modelId}`
    session.selectedModel = { providerId, modelId }
    this.modelStore.set(projectId, providerId, modelId)
    return {
      projectId,
      phase: session.phase,
      isStreaming: false,
      modelLabel: session.modelLabel,
      selectedModel: session.selectedModel,
      providersReady: true
    }
  }

  async getMessages(projectId: string): Promise<AgentUiMessage[]> {
    const session = this.sessions.get(projectId)
    if (!session) return []
    const data = await session.client.command<{ messages: PiMessage[] }>({ type: 'get_messages' })
    return data.messages.flatMap((m, i) => this.mapMessage(m, i))
  }

  // ==================== pi 事件 → AgentStreamEvent ====================

  private handlePiEvent(projectId: string, event: Record<string, unknown>): void {
    const type = event.type as string
    switch (type) {
      case 'agent_start':
        this.emit(projectId, { type: 'agent-start' })
        break
      case 'agent_settled':
        this.emit(projectId, { type: 'agent-settled' })
        break
      case 'message_update': {
        const delta = (event.assistantMessageEvent ?? {}) as Record<string, unknown>
        if (delta.type === 'text_delta') {
          this.emit(projectId, { type: 'text-delta', delta: String(delta.delta ?? '') })
        } else if (delta.type === 'thinking_delta') {
          this.emit(projectId, { type: 'thinking-delta', delta: String(delta.delta ?? '') })
        } else if (delta.type === 'error') {
          const partial = (delta.partial ?? event.message ?? {}) as Record<string, unknown>
          this.emit(projectId, {
            type: 'error',
            message: String(partial.errorMessage ?? 'LLM 请求失败')
          })
        }
        break
      }
      case 'tool_execution_start':
        this.emit(projectId, {
          type: 'tool-start',
          toolName: String(event.toolName ?? ''),
          toolCallId: String(event.toolCallId ?? '')
        })
        break
      case 'tool_execution_end': {
        const result = (event.result ?? {}) as { content?: Array<{ text?: string }> }
        const output = (result.content ?? []).map((c) => c.text ?? '').join('\n')
        this.emit(projectId, {
          type: 'tool-end',
          toolName: String(event.toolName ?? ''),
          toolCallId: String(event.toolCallId ?? ''),
          isError: Boolean(event.isError),
          output: output.length > TOOL_OUTPUT_MAX ? output.slice(0, TOOL_OUTPUT_MAX) + '\n…（截断）' : output
        })
        break
      }
      case 'auto_retry_end':
        if (event.success === false) {
          this.emit(projectId, { type: 'error', message: String(event.finalError ?? '自动重试失败') })
        }
        break
      default:
        break
    }
  }

  // ==================== pi 消息 → AgentUiMessage ====================

  private mapMessage(m: PiMessage, index: number): AgentUiMessage[] {
    const ts = m.timestamp ?? Date.now()
    const id = `${ts}-${index}`

    if (m.role === 'user') {
      const text =
        typeof m.content === 'string'
          ? m.content
          : ((m.content as Array<{ type: string; text?: string }> | undefined) ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
      return text ? [{ id, role: 'user', text, timestamp: ts }] : []
    }

    if (m.role === 'assistant') {
      const blocks = (m.content as Array<Record<string, unknown>> | undefined) ?? []
      const out: AgentUiMessage[] = []
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n')
      if (text) {
        out.push({
          id,
          role: 'assistant',
          text,
          isError: m.stopReason === 'error',
          timestamp: ts
        })
      }
      if (m.stopReason === 'error' && !text) {
        out.push({ id, role: 'assistant', text: m.errorMessage ?? '请求失败', isError: true, timestamp: ts })
      }
      return out
    }

    if (m.role === 'toolResult') {
      const blocks = (m.content as Array<{ text?: string }> | undefined) ?? []
      const text = blocks.map((b) => b.text ?? '').join('\n')
      return [
        {
          id,
          role: 'tool',
          toolName: m.toolName,
          isError: m.isError,
          text: text.length > TOOL_OUTPUT_MAX ? text.slice(0, TOOL_OUTPUT_MAX) + '\n…（截断）' : text,
          timestamp: ts
        }
      ]
    }

    if (m.role === 'bashExecution') {
      return [
        {
          id,
          role: 'tool',
          toolName: 'bash',
          isError: (m as { exitCode?: number }).exitCode !== 0,
          text: `\`${m.command ?? ''}\`\n${m.output ?? ''}`,
          timestamp: ts
        }
      ]
    }

    return []
  }
}
