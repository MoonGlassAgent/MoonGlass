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
import type { MoonGlassService } from '../core/lifecycle.ts'
import type { ProjectService } from './ProjectService.ts'
import type { LlmProviderService } from './LlmProviderService.ts'
import type { AgentModelStore } from './AgentModelStore.ts'
import { PiRpcClient } from '../ai/runtime/pi/PiRpcClient.ts'

/** pi 模型切换命令返回的 Model 对象最小字段 */
interface PiModelInfo {
  id: string
  provider: string
}

/** 会话摘要（供渲染端展示） */
export interface SessionSummary {
  name: string
  file: string
  label: string
  messageCount: number
  isActive: boolean
}

/**
 * pi 内置 provider 会从环境变量 / auth.json 读取 API key。
 * 为避免用户环境变量中已有的 key 覆盖 MoonGlass UI 中的配置，
 * 启动 pi 子进程时屏蔽这些变量，强制走 MOONGLASS_PROVIDERS_JSON。
 */
const PROVIDER_API_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANT_LING_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'NVIDIA_API_KEY',
  'GEMINI_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_GATEWAY_ID',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'ZAI_CODING_CN_API_KEY',
  'OPENCODE_API_KEY',
  'HF_TOKEN',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'KIMI_API_KEY',
  'KIMI_CODING_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP'
]

/** 从 __dirname 向上探测 node_modules 中 pi 的 cli.js（开发模式）。 */
function resolvePiBinFromNodeModules(): string {
  const rel = join('node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/** 定位 pi-coding-agent 的 cli.js：打包后在 extraResources，开发时在 node_modules */
function resolvePiBin(): string {
  // 生产环境：从 extraResources 读取
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'pi-coding-agent', 'dist', 'cli.js')
    if (existsSync(packaged)) return packaged
    console.error('[agent-service] 打包环境未找到 pi-coding-agent（extraResources 配置？）')
  }
  // 开发环境：从 node_modules 探测
  const fromNodeModules = resolvePiBinFromNodeModules()
  if (fromNodeModules) return fromNodeModules
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
  /** 当前会话文件名（如 session.jsonl, session-review.jsonl） */
  currentSessionFile: string
  /** 会话展示名 */
  activeSessionName: string
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
  private projects: ProjectService
  private llm: LlmProviderService
  private modelStore: AgentModelStore

  constructor(
    projects: ProjectService,
    llm: LlmProviderService,
    modelStore: AgentModelStore
  ) {
    this.projects = projects
    this.llm = llm
    this.modelStore = modelStore
  }

  start(): void {
    // 注：pi-coding-agent 是纯 ESM 包（exports 仅声明 import 条件，且不含 ./package.json），
    // CJS 的 require.resolve 无法命中，改为从 __dirname 向上探测 node_modules 实体路径。
    this.piBinPath = resolvePiBin()

    // 桥接扩展复制到 userData（pi 经 -e 加载）
    this.bridgeDir = join(app.getPath('userData'), 'moonglass', 'pi-bridge')
    mkdirSync(this.bridgeDir, { recursive: true })

    // 资源根目录：打包后用 process.resourcesPath，开发时用当前工作目录
    const resourcesDir = app.isPackaged ? process.resourcesPath : process.cwd()

    const copyExt = (name: string): void => {
      const src = app.isPackaged
        ? join(resourcesDir, 'pi-bridge', name)
        : join(resourcesDir, 'resources', 'moonglass', 'pi-bridge', name)
      if (existsSync(src)) copyFileSync(src, join(this.bridgeDir, name))
      else console.error(`[agent-service] 未找到扩展源文件: ${src}`)
    }

    copyExt('moonglass-providers.ts')
    copyExt('moonglass-tools.ts') // Phase 4：芯片专用工具集

    // Phase 4：将 eda-bridge 共享实现复制到 pi-bridge 目录，供 moonglass-tools.ts 相对导入
    const edaBridgeDir = join(this.bridgeDir, 'eda-bridge')
    mkdirSync(edaBridgeDir, { recursive: true })
    const copyEda = (name: string): void => {
      const src = join(resourcesDir, 'pi-bridge', 'eda-bridge', name)
      if (existsSync(src)) copyFileSync(src, join(edaBridgeDir, name))
      else console.error(`[agent-service] 未找到 EDA 桥接源文件: ${src}`)
    }
    copyEda('tool-runner.ts')
    copyEda('simulation.ts')
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

  /** pi 全局配置隔离目录（auth.json / settings.json / models-store.json 等） */
  private piAgentDir(): string {
    return join(app.getPath('userData'), 'moonglass', 'pi-agent')
  }

  /** 会话目录 */
  private sessionDir(projectId: string): string {
    const dir = join(app.getPath('userData'), 'moonglass', 'pi-sessions', projectId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 会话文件路径。支持多会话：session.jsonl（主会话）、session-<name>.jsonl（平行会话）。
   * pi --session 支持绝对路径，文件不存在时会自动创建。
   */
  private sessionFilePath(projectId: string, name = 'main'): string {
    const dir = this.sessionDir(projectId)
    const file = name === 'main' ? join(dir, 'session.jsonl') : join(dir, `session-${name}.jsonl`)
    // 迁移：v0.2 增量版曾按阶段分文件
    if (name === 'main' && !existsSync(file)) {
      const project = this.projects.get(projectId)
      const legacy = project ? join(dir, `${project.currentPhase}.jsonl`) : ''
      if (legacy && existsSync(legacy)) copyFileSync(legacy, file)
    }
    return file
  }

  private writeSystemPrompt(projectId: string, phase: Phase): void {
    const dotPi = join(this.workspaceDir(projectId), '.pi')
    mkdirSync(dotPi, { recursive: true })
    // TODO(Phase 3 后续): 传入项目级约束与用户自定义提示词
    const basePrompt = buildSystemPrompt(phase)

    // Phase 4：追加项目目录结构约定
    const dirGuide = `

## 项目目录结构

工作区使用以下标准目录结构存放各阶段产出：

| 目录 | 用途 |
|------|------|
| \`docs/\` | 需求规格书、模块规格、架构设计文档、接口定义 |
| \`rtl/\` | RTL 源代码（Verilog/SystemVerilog 模块文件） |
| \`rtlqa/\` | Lint 检查脚本与报告、CDC 检查结果、可综合性报告 |
| \`verification/\` | 测试台（testbench）、仿真脚本、覆盖率报告、VCD 波形 |
| \`imp/\` | 综合脚本、SDC 约束文件、网表、后端工程 |

请按各阶段将生成的文件放入对应目录。例如：
- **RTL 阶段**：代码写入 \`rtl/\`
- **验证阶段**：测试台写入 \`verification/\`，检查报告写入 \`rtlqa/\`
- **综合阶段**：约束与网表写入 \`imp/\`
`

    writeFileSync(join(dotPi, 'APPEND_SYSTEM.md'), basePrompt + dirGuide, 'utf-8')

    // Phase 4: 创建 prompt templates 目录和常用模板
    const promptsDir = join(dotPi, 'prompts')
    mkdirSync(promptsDir, { recursive: true })

    // verify 模板：用户敲 /verify <模块名> 一键触发验证闭环
    const verifyTemplate = `---
description: 对指定模块完成完整验证闭环（lint → 可综合性 → 测试台生成 → 仿真）
argument-hint: "<模块名>"
---
请对模块 **$1** 完成完整的验证闭环流程，按以下步骤执行：

## 步骤 1：收集 RTL 文件
使用 collect_rtl_files 扫描工作区，找到 $1 相关的所有 RTL 文件。

## 步骤 2：Lint 检查
对每个 RTL 文件运行 run_verible_lint，记录所有的 Error 和 Warning。
如果有 Error，先修复再继续。

## 步骤 3：可综合性检查
使用 check_synthesizability 对 RTL 文件进行 Yosys 可综合性检查。
如果有不可综合的代码，修复后再继续。

## 步骤 4：生成测试台
使用 generate_tb 基于 RTL 端口生成 Verilator C++ 测试台。
把测试台文件放到 verification/ 目录下。

## 步骤 5：运行仿真
使用 run_simulation 编译并运行仿真。
如果仿真失败，分析日志并修复问题后重试。

## 步骤 6：输出验证报告
汇总以下信息：
- ✅ Lint 结果（Error/Warning 数量）
- ✅ 可综合性结果（cells/wires）
- ✅ 仿真结果（通过/失败，VCD 路径）
- ✅ 报告文件放入 rtlqa/ 目录
- ❌ 发现的问题与修复建议
`
    writeFileSync(join(promptsDir, 'verify.md'), verifyTemplate, 'utf-8')
  }

  private spawnSession(projectId: string, phase: Phase, projectName: string): PiSession {
    if (!this.piBinPath) throw new Error('[agent-service] pi-coding-agent 不可用（依赖未安装？）')
    const workspace = this.workspaceDir(projectId)
    mkdirSync(workspace, { recursive: true })
    this.writeSystemPrompt(projectId, phase)

    const providers = this.readyProviders()
    const sessionFile = this.sessionFilePath(projectId)

    // 隔离 pi 全局配置，并屏蔽所有 provider API key 环境变量，
    // 确保 pi 只使用 MoonGlass UI 中配置的 key（经 MOONGLASS_PROVIDERS_JSON 注入）。
    const piAgentDir = this.piAgentDir()
    mkdirSync(piAgentDir, { recursive: true })
    const cleanEnv: Record<string, string | undefined> = { ...process.env }
    for (const key of PROVIDER_API_KEY_ENV_VARS) {
      delete cleanEnv[key]
    }

    // 调试用：打印已注册 provider 与 key 末尾 4 位（不打印完整 key）
    for (const p of providers) {
      const suffix = p.apiKey.length > 4 ? p.apiKey.slice(-4) : '****'
      console.log(`[agent-service] 将向 pi 注册 provider: ${p.id}, key 后缀: ${suffix}`)
    }

    const client = new PiRpcClient({
      binPath: this.piBinPath,
      args: [
        '--mode', 'rpc',
        '-a', // 信任项目目录（.pi/APPEND_SYSTEM.md 生效的前提）
        '--session', sessionFile,
        '--name', `${projectName} / ${phase}`,
        '-e', join(this.bridgeDir, 'moonglass-providers.ts'),
        '-e', join(this.bridgeDir, 'moonglass-tools.ts') // Phase 4：芯片专用工具集
      ],
      cwd: workspace,
      env: {
        ...cleanEnv,
        MOONGLASS_PROVIDERS_JSON: JSON.stringify(providers),
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        PI_CODING_AGENT_DIR: piAgentDir,
        PI_CODING_AGENT_SESSION_DIR: dirname(sessionFile),
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

    // 从文件名提取会话名
    const sessionName = sessionFile.endsWith('.jsonl')
      ? sessionFile.split(/[\\/]/).pop()!.replace(/^session-?|\.jsonl$/g, '') || 'main'
      : 'main'

    const session: PiSession = {
      client,
      projectId,
      phase,
      modelLabel: '',
      selectedModel: null,
      fingerprint: this.providersFingerprint(),
      currentSessionFile: sessionFile,
      activeSessionName: sessionName
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

      await this.setModelInternal(session, initial.providerId, initial.modelId)
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
    // prompt 回执在模型长响应时可能远超 30s（实际输出走事件流），超时放宽到 15 分钟
    await session.client.command({ type: 'prompt', message: text }, 15 * 60_000)
  }

  /**
   * 创建平行会话（不关闭当前会话）。
   * 利用 pi RPC 的 new_session 命令创建新会话文件，同一 pi 进程管理多个会话。
   * 新会话独立于老会话，可通过 switchSession 切换。
   */
  async resetSession(projectId: string, sessionName?: string): Promise<AgentSessionInfo> {
    const session = this.sessions.get(projectId)
    if (!session) {
      // 无会话时走老逻辑：创建主会话
      return this.ensureSession(projectId)
    }

    const name = sessionName ?? `review-${Date.now().toString(36)}`
    const newFile = this.sessionFilePath(projectId, name)

    // 利用 pi RPC new_session 创建新会话（不重启进程）
    const result = await session.client
      .command<{ cancelled?: boolean }>({
        type: 'new_session',
        parentSession: session.currentSessionFile
      })
      .catch(() => ({ cancelled: false }))

    if (result.cancelled) {
      throw new Error('[agent-service] 创建新会话被取消')
    }

    // 更新当前会话记录
    session.currentSessionFile = newFile
    session.activeSessionName = name

    // 设置会话展示名
    await session.client
      .command({ type: 'set_session_name', name: `${name} (${session.phase})` })
      .catch(() => undefined)

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

  /**
   * 列出项目的所有可用会话
   */
  async listSessions(projectId: string): Promise<SessionSummary[]> {
    const dir = this.sessionDir(projectId)
    const summaries: SessionSummary[] = []
    const active = this.sessions.get(projectId)

    try {
      const files = await Promise.resolve().then(() => {
        const { readdirSync } = require('node:fs') as typeof import('node:fs')
        return readdirSync(dir)
      })

      for (const f of files) {
        if (!f.endsWith('.jsonl') || f.endsWith('.bak.jsonl')) continue
        const name = f.replace(/^session-?|\.jsonl$/g, '') || 'main'
        const filePath = join(dir, f)
        let messageCount = 0
        try {
          const { readFileSync } = require('node:fs') as typeof import('node:fs')
          const content = readFileSync(filePath, 'utf-8')
          messageCount = content.trim().split(/\n/).filter(l => l.trim().length > 0).length
        } catch { /* 忽略 */ }
        summaries.push({
          name,
          file: filePath,
          label: name === 'main' ? '主会话' : name.replace(/^review-/, '审查 '),
          messageCount: Math.max(0, messageCount - 1), // 减掉 header 行
          isActive: active ? active.currentSessionFile === filePath : false
        })
      }
    } catch { /* 无可枚举的会话目录 */ }

    // 按修改时间排序（最新的在前）
    summaries.sort((a, b) => a.name === 'main' ? -1 : b.name === 'main' ? 1 : b.name.localeCompare(a.name))
    return summaries
  }

  /**
   * 切换到另一个会话（利用 pi RPC switch_session）
   */
  async switchSession(projectId: string, sessionName: string): Promise<AgentSessionInfo> {
    const session = this.sessions.get(projectId)
    if (!session) throw new Error('[agent-service] 进程未建立')

    const targetFile = this.sessionFilePath(projectId, sessionName)
    if (!existsSync(targetFile)) throw new Error(`[agent-service] 会话文件不存在: ${targetFile}`)

    const result = await session.client
      .command<{ cancelled?: boolean }>({ type: 'switch_session', sessionPath: targetFile })
      .catch(() => ({ cancelled: false }))

    if (result.cancelled) {
      throw new Error('[agent-service] 切换会话被取消')
    }

    session.currentSessionFile = targetFile
    session.activeSessionName = sessionName

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

  async abort(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session) return
    await session.client.command({ type: 'abort' }).catch(() => undefined)
  }

  /**
   * 切换模型，并验证 pi 确实切换到了目标模型；失败则抛出异常，
   * 避免静默 fallback 到环境变量中的 provider。
   */
  private async setModelInternal(session: PiSession, providerId: string, modelId: string): Promise<void> {
    const result = await session.client.command<PiModelInfo>({
      type: 'set_model',
      provider: providerId,
      modelId
    })
    const actualProvider = result.provider
    const actualModel = result.id
    if (actualProvider !== providerId || actualModel !== modelId) {
      throw new Error(
        `[agent-service] 模型切换失败：期望 ${providerId}/${modelId}，实际 ${actualProvider}/${actualModel}`
      )
    }
    console.log(`[agent-service] 已切换到模型: ${providerId} / ${modelId}`)
    session.modelLabel = `${providerId} / ${modelId}`
    session.selectedModel = { providerId, modelId }
  }

  async setModel(projectId: string, providerId: string, modelId: string): Promise<AgentSessionInfo> {
    const session = this.sessions.get(projectId)
    if (!session) throw new Error('[agent-service] 会话未建立，请先 ensureSession')
    await this.setModelInternal(session, providerId, modelId)
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
