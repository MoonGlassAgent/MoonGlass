/**
 * Agent 会话服务（Phase 2）
 *
 * 以 RPC 模式嵌入真实 Pi Coding Agent（@earendil-works/pi-coding-agent）：
 * 每个项目一个 pi 子进程（`pi --mode rpc`），cwd 为项目工作目录，
 * 系统提示词经 `.pi/APPEND_SYSTEM.md` 注入（buildSystemPrompt 按阶段组装），
 * Provider 配置经权限受限的一次性文件注入桥接扩展。
 *
 * 会话模型：每个项目、每个阶段拥有独立主会话和若干平行会话。阶段推进/回退时
 * 自动切换到目标阶段的独立 JSONL，只继承模型选择，不继承其他阶段的消息历史。
 * 平行会话拥有独立历史，且只能在所属阶段内创建和切换。
 *
 * TODO(Phase 4): 芯片工具集以 pi 扩展注册；按阶段限制工具白名单
 *                （当前使用 pi 默认的 read/write/edit/bash 四工具，不做限制）。
 * TODO(打包): electron-builder 打包时需把 pi 依赖与桥接扩展纳入 extraResources。
 */

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { buildSystemPrompt } from '@moonglass/prompts'
import type { AgentSessionInfo, AgentSessionStats, AgentStreamEvent, AgentUiMessage, IpLibraryRecord, Phase } from '@shared/types'
import { resolveModelContext } from '@shared/model-context'
import { parseDecisionRequest, parseDecisionResponse, parseDecisionResponses } from '@shared/agent-interaction'
import type { MoonGlassService } from '../core/lifecycle.ts'
import type { ProjectService } from './ProjectService.ts'
import type { LlmProviderService } from './LlmProviderService.ts'
import type { AgentModelStore } from './AgentModelStore.ts'
import { PiRpcClient } from '../ai/runtime/pi/PiRpcClient.ts'
import { AgentRunWatchdog, isTruncatedWithoutToolCall, type WatchdogAction } from './AgentRunWatchdog.ts'

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
  modelLabel: string
  selectedModel: { providerId: string; modelId: string } | null
  isActive: boolean
}

/**
 * pi 内置 provider 会从环境变量 / auth.json 读取 API key。
 * 为避免用户环境变量中已有的 key 覆盖 MoonGlass UI 中的配置，
 * 启动 pi 子进程时屏蔽这些变量，强制走一次性 Provider 配置文件。
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

const CHILD_ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'
] as const

function buildChildEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of PROVIDER_API_KEY_ENV_VARS) delete env[key]
  return env
}

/** 将会话文件名统一转换为模型存储使用的逻辑会话名。 */
function sessionNameFromFile(filePath: string): string {
  const fileName = basename(filePath)
  if (fileName === 'session.jsonl') return 'main'
  return fileName.replace(/^session-/, '').replace(/\.jsonl$/, '') || 'main'
}

const PHASE_SESSION_PREFIX = 'phase-'

/** 阶段主会话的稳定逻辑名。阶段回退时会恢复该阶段原有历史。 */
function phaseMainSessionName(phase: Phase): string {
  return `${PHASE_SESSION_PREFIX}${phase.toLowerCase()}`
}

/** 判断逻辑会话名是否属于指定阶段；`--` 后为该阶段的平行会话名。 */
function sessionBelongsToPhase(sessionName: string, phase: Phase): boolean {
  const main = phaseMainSessionName(phase)
  return sessionName === main || sessionName.startsWith(`${main}--`)
}

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

/** 定位 pi-coding-agent 的 cli.js：打包后位于单文件 ASAR，开发时在 node_modules。 */
function resolvePiBin(): string {
  // Electron 的 Node 模式支持直接执行 ASAR 内脚本，避免分发数千个依赖文件。
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'pi-runtime.asar', 'dist', 'cli.js')
    if (existsSync(packaged)) return packaged
    console.error('[agent-service] 打包环境未找到 pi-runtime.asar')
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
  /** 当前会话文件名（如 session-phase-rtl.jsonl） */
  currentSessionFile: string
  /** 会话展示名 */
  activeSessionName: string
  /** 由 Pi agent_start/agent_settled 事件维护，避免运行中查询 RPC 队列。 */
  isStreaming: boolean
  /** 每轮重建的工具活动守护器，避免 Agent 陷入重复读写循环。 */
  watchdog: AgentRunWatchdog
  watchdogActionPending: boolean
}

/** pi 消息（仅声明映射所需的最小形状） */
interface PiMessage {
  role: string
  content?: unknown
  toolName?: string
  toolCallId?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
  command?: string
  output?: string
  timestamp?: number
}

const TOOL_OUTPUT_MAX = 2000
const UI_HISTORY_MAX = 320

export class AgentService implements MoonGlassService {
  readonly name = 'agent-service'

  private sessions = new Map<string, PiSession>()
  /** 切走后仍在执行的会话进程，按项目和会话文件保存。 */
  private backgroundSessions = new Map<string, Map<string, PiSession>>()
  private piBinPath = ''
  private bridgeDir = ''
  private emit: (projectId: string, event: AgentStreamEvent) => void = () => {}
  private readonly pendingStreamEvents = new Map<string, { events: AgentStreamEvent[]; timer: NodeJS.Timeout }>()
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
    copyExt('model-context.ts')
    copyExt('moonglass-tools.ts') // Phase 4：芯片专用工具集

    // Phase 4：将 eda-bridge 共享实现复制到 pi-bridge 目录，供 moonglass-tools.ts 相对导入
    const edaBridgeDir = join(this.bridgeDir, 'eda-bridge')
    mkdirSync(edaBridgeDir, { recursive: true })
    const copyEda = (name: string): void => {
      const src = app.isPackaged
        ? join(resourcesDir, 'pi-bridge', 'eda-bridge', name)
        : join(resourcesDir, 'packages', 'eda-bridge', 'src', name)
      if (existsSync(src)) copyFileSync(src, join(edaBridgeDir, name))
      else console.error(`[agent-service] 未找到 EDA 桥接源文件: ${src}`)
    }
    copyEda('tool-runner.ts')
    copyEda('simulation.ts')
    copyEda('synthesis.ts')
    copyEda('lint.ts')
    copyEda('rtl-files.ts')
    copyEda('formal.ts')

    const verificationIntelligenceDir = join(this.bridgeDir, 'verification-intelligence')
    mkdirSync(verificationIntelligenceDir, { recursive: true })
    for (const name of ['engine.ts', 'types.ts', 'structural-analyzer.ts']) {
      const src = app.isPackaged
        ? join(resourcesDir, 'verification-intelligence', name)
        : join(resourcesDir, 'packages', 'verification-intelligence-engine', 'src', name)
      if (existsSync(src)) copyFileSync(src, join(verificationIntelligenceDir, name))
      else console.error(`[agent-service] 未找到 Verification Intelligence 源文件: ${src}`)
    }

    // MoonGlass 使用隔离的 Pi 目录；内置技能必须复制并显式写入该目录的设置。
    const piAgentDir = this.piAgentDir()
    const skillsDir = join(piAgentDir, 'skills')
    const skillsSource = app.isPackaged
      ? join(resourcesDir, 'skills')
      : join(resourcesDir, 'resources', 'moonglass', 'skills')
    mkdirSync(piAgentDir, { recursive: true })
    if (existsSync(skillsSource)) {
      cpSync(skillsSource, skillsDir, { recursive: true, force: true })
      const settingsPath = join(piAgentDir, 'settings.json')
      let settings: Record<string, unknown> = {}
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
        } catch (error) {
          console.error('[agent-service] Pi settings.json 无法解析，保留原文件', error)
          return
        }
      }
      settings.skills = [skillsDir.replaceAll('\\', '/')]
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    } else {
      console.error(`[agent-service] 未找到内置技能目录: ${skillsSource}`)
    }
  }

  stop(): void {
    for (const pending of this.pendingStreamEvents.values()) clearTimeout(pending.timer)
    this.pendingStreamEvents.clear()
    for (const session of this.sessions.values()) session.client.dispose()
    for (const projectSessions of this.backgroundSessions.values()) {
      for (const session of projectSessions.values()) session.client.dispose()
    }
    this.sessions.clear()
    this.backgroundSessions.clear()
  }

  private backgroundFor(projectId: string): Map<string, PiSession> {
    let sessions = this.backgroundSessions.get(projectId)
    if (!sessions) {
      sessions = new Map<string, PiSession>()
      this.backgroundSessions.set(projectId, sessions)
    }
    return sessions
  }

  private disposeBackgroundSessions(projectId: string): void {
    const sessions = this.backgroundSessions.get(projectId)
    if (!sessions) return
    for (const session of sessions.values()) session.client.dispose()
    this.backgroundSessions.delete(projectId)
  }

  /** 项目目录切换前释放该项目的全部 Pi 进程，后续进入项目时会从新路径重新创建。 */
  prepareProjectMigration(projectId: string): void {
    const pending = this.pendingStreamEvents.get(projectId)
    if (pending) clearTimeout(pending.timer)
    this.pendingStreamEvents.delete(projectId)
    const active = this.sessions.get(projectId)
    if (active) active.client.dispose()
    this.sessions.delete(projectId)
    this.disposeBackgroundSessions(projectId)
  }

  /** 由主进程入口注入事件推送通道（webContents.send） */
  attachEmitter(emit: (projectId: string, event: AgentStreamEvent) => void): void {
    this.emit = emit
  }

  private queueStreamEvent(projectId: string, event: AgentStreamEvent): void {
    const pending = this.pendingStreamEvents.get(projectId)
    if (pending) {
      const last = pending.events.at(-1)
      if (event.type === 'text-delta' && last?.type === 'text-delta') {
        last.delta += event.delta
      } else if (event.type === 'thinking-delta' && last?.type === 'thinking-delta') {
        last.delta += event.delta
      } else {
        pending.events.push(event)
      }
      return
    }
    const events = [event]
    const timer = setTimeout(() => this.flushStreamEvents(projectId), 50)
    this.pendingStreamEvents.set(projectId, { events, timer })
  }

  private flushStreamEvents(projectId: string): void {
    const pending = this.pendingStreamEvents.get(projectId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingStreamEvents.delete(projectId)
    for (const event of pending.events) this.emit(projectId, event)
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
    return this.projects.workspaceDir(projectId)
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

  /** 会话文件路径。pi --session 支持绝对路径，文件不存在时会自动创建。 */
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

  /** 当前阶段主会话文件；新阶段始终从独立 JSONL 开始。 */
  private phaseSessionFilePath(projectId: string, phase: Phase): string {
    return join(this.sessionDir(projectId), `session-${phaseMainSessionName(phase)}.jsonl`)
  }

  private storedSessionLabel(sessionFile: string): string | undefined {
    try {
      let label: string | undefined
      for (const line of readFileSync(sessionFile, 'utf-8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as { type?: string; name?: string }
          if (entry.type === 'session_info' && entry.name) label = entry.name
        } catch { /* 忽略尚未写完的末行 */ }
      }
      return label
    } catch {
      return undefined
    }
  }

  private writeSystemPrompt(projectId: string, phase: Phase): void {
    const dotPi = join(this.workspaceDir(projectId), '.pi')
    mkdirSync(dotPi, { recursive: true })
    // TODO(Phase 3 后续): 传入项目级约束与用户自定义提示词
    const basePrompt = buildSystemPrompt(phase)
    const processLibraryIndex = join(app.getPath('userData'), 'moonglass', 'process-libraries', 'index.json')
    const ipLibraryIndex = join(app.getPath('userData'), 'moonglass', 'ip-libraries', 'index.json')
    const ipLibraryGuide = join(app.getPath('userData'), 'moonglass', 'ip-libraries', 'IP_LIBRARY_GUIDE.md')
    const project = this.projects.get(projectId)
    const fastTrackNotice =
      phase === 'SYNTH' &&
      (project?.phases.VERIF.status === 'skipped' || project?.phases.QA.status === 'skipped')
        ? `

## 快速面积评估模式

用户已明确跳过 VERIF 和 QA。本阶段仅用于快速获得综合面积估算：
- 优先完成可综合性检查、SDC 生成、Yosys 综合和面积报告。
- 报告必须醒目标注“未经过验证与 QA，不可作为签核或发布依据”。
- 不得宣称功能正确、验证通过或质量检查通过。
`
        : ''

    // Phase 4：追加项目目录结构约定
    const dirGuide = `

## 强制项目目录与技能规则

\`\`\`text
docs/{01_project,02_requirements,03_design,04_verification,05_implementation,06_validation,07_release}/
rtl/
rtl/macros/
rtlqa/{lint,cdc}/
verification/<module>_tb/{agents,env,coverage,tests,sequences,sim}/
verification/results/<module>/
imp/{constraints,synthesis}/
scripts/
\`\`\`

- 文档工作必须使用 \`doc-repository\` 技能并写入对应规范文件。
- 首次进入验证实现前必须使用 \`verification-planning\`；已有通过校验的验证规划时应直接增量复用，再使用 \`cocotb-verification\`，不得因每个子任务重复重建全套文档。
- RTL 只写入 \`rtl/\`；Lint/CDC 报告分别写入 \`rtlqa/lint/\` 和 \`rtlqa/cdc/\`。
- RTL 阶段必须维护 \`rtl/design.json\` 和 \`rtl/filelist.f\`：design.json 的 filelist 写字符串 \`"filelist.f"\`，源文件顺序逐行写入 filelist.f，并明确 topModule、includeDirs 与 defines。
- 默认假设没有可用 SRAM/ROM 宏。若架构需要存储宏，先在 \`docs/03_design/architecture.md\` 记录组织、端口、时序、面积/功耗估算和替换责任，再把存储体从控制器剥离为参数化 bank 级宏接口。
- 当用户给出固定尺寸 wrapper 和真实 SRAM 实体名但没有厂商仿真模型时，调用 \`generate_sram_macro_views\` 生成同名 behavioral/blackbox/wrapper/manifest；depth 非二次幂时必须保留非法地址检查。获得 Memory Compiler 官方 Verilog/Liberty 后，优先替换通用模型并重新回归。
- 存储宏三视图写入 \`rtl/macros/\`：\`sram_behavioral.v\` 仅仿真，\`sram_blackbox.v\` 仅综合并用 \`read_verilog -lib\`，\`sram_phy_template.v\` 仅作物理宏例化/端口映射交付物。三者不得在同一次工具调用中作为普通 RTL 同时读入。
- \`rtl/design.json\` 用 \`simulationFiles\`、\`libraryFiles\`、\`physicalFiles\` 分别登记三类视图；\`filelist.f\` 仅放控制逻辑和其他普通设计源。宏面积/功耗按架构或数据手册单独报告，不得伪装成 Yosys 标准单元面积。
- Agent 新生成的 RTL 默认符合 Verilog-2001 并使用 \`.v\`；生成的验证断言可使用 SystemVerilog/SVA。此生成约束不得用于拒绝或改写用户导入的较新标准代码。
- 仿真日志、机器可读结果、覆盖率与波形必须写入 \`verification/results/<module>/\`。
- 主会话必须完成端到端验证闭环：先以 Cocotb + Icarus 完成功能回归和功能覆盖率；Windows 再以 Verilator C++ 模式采集 RTL 行、条件/表达式、翻转和 FSM 覆盖率，Linux 可直接使用 Cocotb + Verilator。不得自行生成临时 runner 绕过工具。
- 验证结束前必须调用 \`review_verification_evidence\` 独立读取原始测试、日志、JUnit、result.json 和覆盖率；存在阻断项时继续修复和回归，不能以自己的总结作为签核证据。
- 验证规划必须调用 \`build_verification_intelligence\`，根据 Requirement Model、RTL 结构事实、风险分类和 Coverage Feedback 选择最高价值 Scenario；不得把风险标记写成已确认 Bug，也不得生成无结构依据的任意 Feature 笛卡尔积。
- 智能验证必须读取 \`verification-intent-registry.json\`、\`spec-gap-register.json\` 和 \`coverage-hole-register.json\`；覆盖缺口必须区分不可达、约束阻断、激励缺失、观察缺失、规格未定义与工具/插桩问题，不能只靠增加随机种子掩盖。
- \`verification/intelligence/\` 下的 JSON（\`verification-posture.json\`、\`verification-state.json\`、\`scenario-registry.json\`、\`verification-intent-registry.json\`、\`coverage-hole-register.json\` 等）是 \`build_verification_intelligence\` 等工具生成的机器可读产物，Agent 禁止手工编辑或覆盖它们；\`verification/results/\` 下的 \`scenario_hits.json\` 由 \`run_simulation(scenarioIds=...)\` 自动登记，同样禁止手工编辑或覆盖。批次进度、规格裁决、门禁结论只能写入 \`docs/04_verification/\` 的 Markdown 报告或 \`verification/results/\` 下的其他证据文件。场景裁决（规格澄清/豁免/验证结果）必须调用 \`record_scenario_adjudication\` 工具写回，该工具会自动重新生成态势快照。
- 每个智能规划 Scenario 必须使用稳定 SCN-* ID；仿真通过 \`run_simulation\` 的 \`scenarioIds\` 参数绑定场景，reach/pass/证据由工具自动写入 \`verification/results/<module>/scenario_hits.json\`。关键 Scenario 必须验证、Formal 证明、证明不可达或经批准豁免，最后调用 \`review_verification_scenarios\`。
- RTL 修复按影响分级：L1 语法/位宽/Lint/局部 Coding Bug 与 L2 不改变已批准规格的状态、握手、边界和异常修复可直接修改并自动完成定向复现、受影响回归、全量回归、覆盖率/Formal 与独立证据 Review；L3 接口、寄存器映射、时钟复位、数据宽度、PPA 目标、SRAM 组织等架构影响，或 L4 需求语义、优先级、并发行为、外部可见行为变化，必须用标题含 \`[L3]\` 或 \`[L4]\` 的结构化决策请求暂停并等待用户裁决。
- 自动修复不得删除失败用例、削弱 Checker/Assertion/覆盖率目标、扩大 don't-care，或在没有规格依据时修改测试预期；RTL 与测试同时修改必须执行独立 Review。连续修复失败或影响扩散时升级为 L3。
- SDC 写入 \`imp/constraints/\`；网表、综合日志、时序和面积报告写入 \`imp/synthesis/\`。
- 综合优先使用 MoonGlass 工艺库索引选定的默认 Liberty；若没有配置默认库，允许通用综合，但须明确提示面积和时序不具备工艺意义。
- MoonGlass 工艺库统一索引路径：${processLibraryIndex.replace(/\\/g, '/')}。涉及工艺选择、综合、时序或物理视图前，先读取该索引并核对 Liberty/LEF/GDS/Verilog 等可用文件；不得只凭目录名猜测文件。用户新增或下载工艺库后，以该索引为准。
- MoonGlass IP 模板库统一索引路径：${ipLibraryIndex.replace(/\\/g, '/')}。优先调用 \`ip_search\` 缩小候选，再用 \`ip_inspect\` 核对模板名称、类型、topModule、RTL/验证/文档文件；库规模很大时不得把整份 index.json 读入上下文，也不得只凭页面分类或目录名猜测可用模板。
- IP 库使用指南：${ipLibraryGuide.replace(/\\/g, '/')}。在 REQ_SPEC/ARCH 阶段先检索现有能力并说明采用或不采用理由；RTL 阶段优先评估 componentKind 为 rtl-ip/mixed 的候选；VERIF 阶段优先评估 verification-component/mixed 的 VIP、BFM、monitor、driver 和 testbench 资源。
- IP 库源目录默认只读，不得直接修改。采用 IP 前必须核对 protocols、interfaceRoles、topModule、依赖、时钟复位、许可证和质量证据；信息不足时请求用户确认。需要适配时在项目中生成 wrapper/adapter，并在阶段文档中记录 IP 库名称、源路径与采用理由。
- 当需求、规格、架构或约束存在两种以上合理选项并需要用户决定时，必须调用 \`request_user_decision\`，不要只在普通文本中列出编号让用户手工回复。单选和多选默认允许用户补充自己的要求；选项应说明关键面积、性能、功耗、验证或交付影响，并且最多标记一个推荐项。调用后停止继续决策，等待用户回答。
- 不得在根目录或旧式平铺目录创建阶段产出；不得虚构工具结果。
`

    writeFileSync(join(dotPi, 'APPEND_SYSTEM.md'), basePrompt + dirGuide + fastTrackNotice, 'utf-8')

    // Phase 4: 创建 prompt templates 目录和常用模板
    const promptsDir = join(dotPi, 'prompts')
    mkdirSync(promptsDir, { recursive: true })

    // verify 模板：用户敲 /verify <模块名> 一键触发验证闭环
    const verifyTemplate = `---
description: 对指定模块完成规范化验证闭环
argument-hint: "<模块名>"
---
请对模块 **$1** 完成完整验证闭环：

1. 使用 verification-planning 技能维护 docs/04_verification/ 三份基线计划与六份 AIGV 方法/闭环文档。
2. 使用 collect_rtl_files、read_verilog、run_verible_lint 和 check_synthesizability。
3. 使用 cocotb-verification 技能在 verification/$1_tb/ 创建规范环境。
4. 调用 build_verification_intelligence 生成风险候选与结构事实，阅读后圈定 5~10 个真实验证点并用 register_verification_intents 登记（锚定真实 riskIds/requirementIds/rtlSignals），再用 select_next_verification_batch 选择最高优先级 Scenario，优先配置现有 sequence/driver 并在测试中绑定 SCN-* ID。
5. 完善 Cocotb 测试后，使用 run_simulation(mode="cocotb", testModule=..., testDir=..., simulator="icarus", scenarioIds=[...]) 实际运行；scenario_hits.json 与态势快照由工具自动登记重建，禁止手写。
6. 确认 verification/results/$1/ 中存在编译日志、仿真日志、result.json、scenario_hits.json 和波形。
7. 完成关键 Scenario 后调用 review_verification_scenarios 与 review_verification_evidence；执行派生状态由证据派生，record_scenario_adjudication 仅用于规格澄清/豁免且 WAIVED 需已有具名审批。
8. 用实际 JSON、日志、覆盖率和 Formal 证据更新 AIGV 策略、Intent 矩阵、风险场景、Formal、Coverage Closure、Signoff 文档以及 docs/06_validation/ 验证报告；工具失败时分析日志、修复并重跑。
`
    writeFileSync(join(promptsDir, 'verify.md'), verifyTemplate, 'utf-8')
  }

  private spawnSession(
    projectId: string,
    phase: Phase,
    projectName: string,
    targetSessionFile?: string
  ): PiSession {
    if (!this.piBinPath) throw new Error('[agent-service] pi-coding-agent 不可用（依赖未安装？）')
    const workspace = this.workspaceDir(projectId)
    mkdirSync(workspace, { recursive: true })
    this.writeSystemPrompt(projectId, phase)

    const providers = this.readyProviders()
    const sessionFile = resolve(targetSessionFile ?? this.sessionFilePath(projectId))

    // 隔离 pi 全局配置，并屏蔽所有 provider API key 环境变量，
    // 确保 pi 只使用 MoonGlass UI 中配置的 key（经一次性文件注入）。
    const piAgentDir = this.piAgentDir()
    mkdirSync(piAgentDir, { recursive: true })
    const cleanEnv = buildChildEnvironment()
    const providerFile = join(piAgentDir, `providers-${randomUUID()}.json`)
    const sramGenerator = app.isPackaged
      ? join(process.resourcesPath, 'ip-library', 'memory', 'sram_macro_generator', 'scripts', 'generate_sram_views.py')
      : join(process.cwd(), 'resources', 'moonglass', 'ip-library', 'memory', 'sram_macro_generator', 'scripts', 'generate_sram_views.py')
    writeFileSync(providerFile, JSON.stringify(providers), { encoding: 'utf-8', mode: 0o600 })

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
        MOONGLASS_PROVIDERS_FILE: providerFile,
        MOONGLASS_IP_LIBRARY_INDEX: join(app.getPath('userData'), 'moonglass', 'ip-libraries', 'index.json'),
        MOONGLASS_SRAM_GENERATOR: sramGenerator,
        ...(process.env.MOONGLASS_DEFAULT_LIBERTY
          ? { MOONGLASS_DEFAULT_LIBERTY: process.env.MOONGLASS_DEFAULT_LIBERTY }
          : {}),
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        PI_CODING_AGENT_DIR: piAgentDir,
        PI_CODING_AGENT_SESSION_DIR: dirname(sessionFile),
        // 主进程 process.execPath 是 Electron 二进制；缺此变量时子进程不执行脚本直接退出
        ELECTRON_RUN_AS_NODE: '1'
      },
      onEvent: (event) => {
        if (event.type === 'agent_start') {
          session.isStreaming = true
          session.watchdog = new AgentRunWatchdog(session.phase)
          session.watchdogActionPending = false
        }
        if (event.type === 'agent_settled') session.isStreaming = false
        this.observeWatchdogEvent(projectId, session, event)
        if (this.sessions.get(projectId) === session) this.handlePiEvent(projectId, event)
      },
      onExit: (code, stderrTail) => {
        // 防止旧进程异步退出时误删已重建的新会话
        const current = this.sessions.get(projectId)
        if (current === session) {
          this.sessions.delete(projectId)
          this.emit(projectId, {
            type: 'error',
            message: `pi 进程退出 (code=${code})${stderrTail ? `\n${stderrTail.slice(-500)}` : ''}`
          })
          return
        }
        const background = this.backgroundSessions.get(projectId)
        if (background?.get(resolve(session.currentSessionFile)) === session) {
          background.delete(resolve(session.currentSessionFile))
          if (background.size === 0) this.backgroundSessions.delete(projectId)
        }
      }
    })
    client.start()
    // 扩展正常加载后会立即删除；启动失败时也限制敏感文件最多保留一分钟。
    setTimeout(() => rmSync(providerFile, { force: true }), 60_000)

    // 从文件名提取会话名
    const sessionName = sessionNameFromFile(sessionFile)

    const session: PiSession = {
      client,
      projectId,
      phase,
      modelLabel: '',
      selectedModel: null,
      fingerprint: this.providersFingerprint(),
      currentSessionFile: sessionFile,
      activeSessionName: sessionName,
      isStreaming: false,
      watchdog: new AgentRunWatchdog(phase),
      watchdogActionPending: false
    }
    this.sessions.set(projectId, session)
    return session
  }

  async ensureSession(projectId: string): Promise<AgentSessionInfo> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`[agent-service] 项目不存在: ${projectId}`)

    const providers = this.readyProviders()
    if (providers.length === 0) {
      const currentSession = this.sessions.get(projectId)
      const activeSessionName = currentSession?.phase === project.currentPhase
        ? currentSession.activeSessionName
        : phaseMainSessionName(project.currentPhase)
      return {
        projectId,
        phase: project.currentPhase,
        sessionName: activeSessionName,
        isStreaming: false,
        modelLabel: '',
        selectedModel: null,
        providersReady: false
      }
    }

    const fingerprint = this.providersFingerprint()
    let session = this.sessions.get(projectId)

    // Provider 配置变更或阶段变化都需要重启 pi 进程（两者都只能在进程启动时生效）。
    // 阶段变化后切换到目标阶段自己的 JSONL，避免需求/架构/失败轨迹污染 RTL 等下游阶段。
    if (session && (session.fingerprint !== fingerprint || session.phase !== project.currentPhase)) {
      session.client.dispose()
      this.sessions.delete(projectId)
      this.disposeBackgroundSessions(projectId)
      session = undefined
    }

    if (!session) {
      const rememberedSessionName = this.modelStore.getActiveSession(projectId)
      const rememberedSessionFile = rememberedSessionName && sessionBelongsToPhase(rememberedSessionName, project.currentPhase)
        ? join(this.sessionDir(projectId), `session-${rememberedSessionName}.jsonl`)
        : ''
      const targetSessionFile = rememberedSessionFile && existsSync(rememberedSessionFile)
        ? rememberedSessionFile
        : this.phaseSessionFilePath(projectId, project.currentPhase)
      session = this.spawnSession(projectId, project.currentPhase, project.name, targetSessionFile)
      await session.client.waitReady()

      // 阶段会话优先恢复自己的模型；首次进入阶段时继承上一活动会话的模型选择，但不继承历史。
      const previousSelection = rememberedSessionName
        ? this.modelStore.get(projectId, rememberedSessionName)
        : undefined
      const selection = this.modelStore.get(projectId, session.activeSessionName) ?? previousSelection
      const initial =
        selection && providers.some((p) => p.id === selection.providerId && p.models.includes(selection.modelId))
          ? selection
          : { providerId: providers[0].id, modelId: providers[0].models[0] }

      await this.setModelInternal(session, initial.providerId, initial.modelId)
      this.modelStore.set(projectId, session.activeSessionName, initial.providerId, initial.modelId)
      this.modelStore.setActiveSession(projectId, session.activeSessionName)
    }

    return {
      projectId,
      phase: session.phase,
      sessionName: session.activeSessionName,
      isStreaming: session.isStreaming,
      modelLabel: session.modelLabel,
      selectedModel: session.selectedModel,
      providersReady: true
    }
  }

  async prompt(projectId: string, text: string): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session) throw new Error('[agent-service] 会话未建立，请先 ensureSession')
    // 兜底校验：即使渲染层 streaming 标志与真实状态漂移，也不能把第二条 prompt 发给正在运行的 Agent。
    if (session.isStreaming) {
      throw new Error('Agent 仍在处理上一轮任务，请等待完成后再发送新消息')
    }
    let message = text
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Pi 的 prompt response 仅表示命令已接收；文件和工具工作要到 agent_settled 才完成。
      // 必须先注册事件等待器，避免极短轮次在 RPC response 前 settled 造成竞态。
      const completion = session.client.waitForEvent((event) => {
        if (event.type === 'agent_settled') return true
        if (event.type !== 'message_update') return false
        const delta = (event.assistantMessageEvent ?? {}) as Record<string, unknown>
        return delta.type === 'error'
      }, 60 * 60_000)
      const [, terminalEvent] = await Promise.all([
        session.client.command({ type: 'prompt', message }, 15 * 60_000),
        completion
      ])
      if (terminalEvent.type === 'message_update') {
        const delta = (terminalEvent.assistantMessageEvent ?? {}) as Record<string, unknown>
        throw new Error(String(delta.errorMessage ?? delta.error ?? 'Agent 执行失败'))
      }
      if (!this.lastAssistantTruncatedWithoutTool(session.currentSessionFile)) return
      if (attempt === 3) {
        throw new Error(
          '模型连续 3 轮仅输出思考过程，并因输出长度限制截断，未产生任何工具调用。' +
          'MoonGlass 已停止本任务，避免继续空转；请切换更适合 Coding Agent 工具调用的模型后重试。'
        )
      }
      this.emit(projectId, {
        type: 'status',
        message: `模型第 ${attempt} 轮因长度限制截断且未执行工具，MoonGlass 正在要求其跳过重复规划并立即落盘。`
      })
      message = `[MoonGlass 执行恢复 ${attempt}/2]\n` +
        '上一轮只输出了思考过程，并在生成任何工具调用前因长度限制截断。' +
        '禁止重复规划、复述模块清单或一次性设计全部实现。现在立即调用一个实际工具完成最小可验证动作：' +
        '先检查真实工作区；若产物不存在，直接创建第一个文件；若产物存在，直接运行用户要求的检查。' +
        '完成该动作后再增量继续。'
    }
  }

  private lastAssistantTruncatedWithoutTool(sessionFile: string): boolean {
    return isTruncatedWithoutToolCall(this.readSessionMessages(sessionFile))
  }

  /**
   * 创建平行会话并切换到该会话。旧会话文件保留，可随时切回。
   * MoonGlass 先持久化合法的空白会话，避免 Pi 在首条消息前不落盘。
   */
  async resetSession(projectId: string, sessionName?: string): Promise<AgentSessionInfo> {
    const session = this.sessions.get(projectId)
    if (!session) {
      // 无会话时走老逻辑：创建主会话
      return this.ensureSession(projectId)
    }

    const name = sessionName?.trim() || `review-${Date.now().toString(36)}`
    const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
    const scopedName = `${phaseMainSessionName(session.phase)}--${safeName}`
    let fileName = `session-${scopedName}.jsonl`
    let newFile = join(this.sessionDir(projectId), fileName)
    if (existsSync(newFile)) {
      fileName = `session-${scopedName}-${Date.now().toString(36)}.jsonl`
      newFile = join(this.sessionDir(projectId), fileName)
    }
    const now = new Date().toISOString()
    const headerId = randomUUID()
    const infoId = randomUUID().slice(0, 8)
    writeFileSync(
      newFile,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: headerId,
          timestamp: now,
          cwd: this.workspaceDir(projectId)
        }),
        JSON.stringify({
          type: 'session_info',
          id: infoId,
          parentId: null,
          timestamp: now,
          name: `${name} (${session.phase})`
        })
      ].join('\n') + '\n',
      'utf-8'
    )

    try {
      return await this.switchSession(projectId, sessionNameFromFile(newFile))
    } catch (error) {
      rmSync(newFile, { force: true })
      throw error
    }
  }

  /** 压缩当前 Pi 上下文，保留会话历史及由模型生成的摘要。 */
  async compactSession(projectId: string): Promise<AgentSessionInfo> {
    const session = this.sessions.get(projectId)
    if (!session) throw new Error('[agent-service] 会话未建立')
    if (session.isStreaming) throw new Error('Agent 正在运行，请先等待完成或中止任务')
    await session.client.command({ type: 'compact' }, 15 * 60_000)
    return this.ensureSession(projectId)
  }

  /**
   * 归档活动 JSONL，并用同名空白 session 重启 Pi。新进程不读取旧消息，
   * 但会恢复当前标签、阶段和模型选择。归档不参与正常会话列表，避免误切回。
   */
  async restartSessionFresh(projectId: string): Promise<AgentSessionInfo> {
    const session = this.sessions.get(projectId)
    if (!session) throw new Error('[agent-service] 会话未建立')
    if (session.isStreaming) throw new Error('Agent 正在运行，请先等待完成或中止任务')
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`[agent-service] 项目不存在: ${projectId}`)
    const selectedModel = session.selectedModel
    const sessionFile = session.currentSessionFile
    const sessionName = session.activeSessionName
    const storedLabel = this.storedSessionLabel(sessionFile)
    const archiveDir = join(this.sessionDir(projectId), 'archive')
    mkdirSync(archiveDir, { recursive: true })
    if (existsSync(sessionFile)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      copyFileSync(sessionFile, join(archiveDir, `${basename(sessionFile, '.jsonl')}-${stamp}.jsonl`))
    }
    this.sessions.delete(projectId)
    session.client.dispose()
    const now = new Date().toISOString()
    writeFileSync(sessionFile, [
      JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp: now, cwd: this.workspaceDir(projectId) }),
      JSON.stringify({ type: 'session_info', id: randomUUID().slice(0, 8), parentId: null, timestamp: now, name: storedLabel ?? `${sessionName === 'main' ? '主会话' : sessionName} (${session.phase})` })
    ].join('\n') + '\n', 'utf-8')

    const replacement = this.spawnSession(projectId, session.phase, project.name, sessionFile)
    await replacement.client.waitReady()
    if (selectedModel) {
      await this.setModelInternal(replacement, selectedModel.providerId, selectedModel.modelId)
      this.modelStore.set(projectId, sessionName, selectedModel.providerId, selectedModel.modelId)
    }
    this.modelStore.setActiveSession(projectId, sessionName)
    return {
      projectId,
      phase: replacement.phase,
      sessionName: replacement.activeSessionName,
      isStreaming: false,
      modelLabel: replacement.modelLabel,
      selectedModel: replacement.selectedModel,
      providersReady: true
    }
  }

  /**
   * 彻底移除指定阶段的活动/后台进程、JSONL 和模型选择。
   * 必须在删除阶段产物前调用，避免仍在运行的 Agent 把文件重新写回工作区。
   */
  clearPhaseSessions(projectId: string, phase: Phase): void {
    const active = this.sessions.get(projectId)
    const preservedModel = active?.phase === phase ? active.selectedModel : null
    if (active?.phase === phase) {
      this.flushStreamEvents(projectId)
      this.sessions.delete(projectId)
      active.client.dispose()
    }

    const background = this.backgroundSessions.get(projectId)
    if (background) {
      for (const [file, session] of background) {
        if (session.phase !== phase) continue
        session.client.dispose()
        background.delete(file)
      }
      if (background.size === 0) this.backgroundSessions.delete(projectId)
    }

    const dir = this.sessionDir(projectId)
    for (const fileName of readdirSync(dir)) {
      if (!fileName.endsWith('.jsonl')) continue
      const filePath = join(dir, fileName)
      const sessionName = sessionNameFromFile(filePath)
      if (!sessionBelongsToPhase(sessionName, phase)) continue
      rmSync(filePath, { force: true })
      this.modelStore.delete(projectId, sessionName)
    }

    // 无上下文重启产生的归档也属于该阶段；purge 语义下不保留可再次污染的副本。
    const archiveDir = join(dir, 'archive')
    if (existsSync(archiveDir)) {
      const prefix = `session-${phaseMainSessionName(phase)}`
      for (const fileName of readdirSync(archiveDir)) {
        if (fileName.startsWith(prefix) && fileName.endsWith('.jsonl')) {
          rmSync(join(archiveDir, fileName), { force: true })
        }
      }
    }

    // Provider/模型属于用户配置而非会话上下文；保留当前选择供下一次显式工作复用。
    if (preservedModel) {
      const mainName = phaseMainSessionName(phase)
      this.modelStore.set(projectId, mainName, preservedModel.providerId, preservedModel.modelId)
      this.modelStore.setActiveSession(projectId, mainName)
    }
  }

  /** 使用独立、短生命周期的 Pi 会话为确定性 IP 索引补充语义字段。 */
  async analyzeIpLibrary(record: IpLibraryRecord): Promise<{
    model: string
    ips: Array<{ id: string; name?: string; type?: string; summary?: string; protocols?: string[]; interfaceRoles?: string[]; licenseStatus?: 'identified' | 'unknown' | 'restricted'; confidence?: number }>
  }> {
    if (!this.piBinPath) throw new Error('Pi Coding Agent 不可用')
    const provider = this.readyProviders()[0]
    const modelId = provider?.models[0]
    if (!provider || !modelId) throw new Error('没有已启用且配置完成的模型服务，无法启动 Pi 语义分析')
    const analysisDir = join(app.getPath('userData'), 'moonglass', 'ip-analysis')
    mkdirSync(analysisDir, { recursive: true })
    const providerFile = join(analysisDir, `providers-${randomUUID()}.json`)
    const sessionFile = join(analysisDir, `session-${randomUUID()}.jsonl`)
    writeFileSync(providerFile, JSON.stringify(this.readyProviders()), { encoding: 'utf-8', mode: 0o600 })
    let responseText = ''
    let processError = ''
    const client = new PiRpcClient({
      binPath: this.piBinPath,
      args: ['--mode', 'rpc', '--session', sessionFile, '--name', `IP Library Analysis / ${record.name}`, '-e', join(this.bridgeDir, 'moonglass-providers.ts')],
      cwd: record.path,
      env: {
        ...buildChildEnvironment(),
        MOONGLASS_PROVIDERS_FILE: providerFile,
        PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: this.piAgentDir(),
        PI_CODING_AGENT_SESSION_DIR: analysisDir, ELECTRON_RUN_AS_NODE: '1'
      } as Record<string, string>,
      onEvent: (event) => {
        if (event.type !== 'message_update') return
        const delta = (event.assistantMessageEvent ?? {}) as Record<string, unknown>
        if (delta.type === 'text_delta') responseText += String(delta.delta ?? '')
        if (delta.type === 'error') processError = String(delta.errorMessage ?? delta.error ?? '模型分析失败')
      },
      onExit: (_code, stderr) => { if (stderr) processError = stderr.slice(-1000) }
    })
    try {
      client.start()
      await client.waitReady()
      const actual = await client.command<PiModelInfo>({ type: 'set_model', provider: provider.id, modelId })
      if (actual.provider !== provider.id || actual.id !== modelId) throw new Error('Pi 语义分析模型切换失败')
      const compact = record.ips.map((ip) => ({
        id: ip.id, name: ip.name, type: ip.type, componentKind: ip.componentKind, topModule: ip.topModule,
        protocols: ip.protocols, interfaceRoles: ip.interfaceRoles, rtlFiles: ip.rtlFiles.slice(0, 12),
        verificationFiles: ip.verificationFiles.slice(0, 12), documentFiles: ip.documentFiles.slice(0, 8), path: ip.path
      }))
      const results: Array<Record<string, unknown>> = []
      const finalAssistantText = async (): Promise<string> => {
        const data = await client.command<{ messages: PiMessage[] }>({ type: 'get_messages' })
        const message = [...data.messages].reverse().find((item) => item.role === 'assistant')
        if (!message) return responseText
        if (typeof message.content === 'string') return message.content
        return ((message.content as Array<{ type?: string; text?: string }> | undefined) ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text ?? '')
          .join('\n') || responseText
      }
      const analyzeBatch = async (batch: typeof compact, singleRetry = false): Promise<void> => {
        responseText = ''
        processError = ''
        const prompt = `你是 ASIC IP 库管理员。只分析下列确定性扫描结果，不修改任何文件，也不要调用工具。\n` +
          `为每个输入 id 返回一项。只输出 JSON 数组，不要 Markdown。字段：id、name、type、summary（中文一句话）、protocols（字符串数组）、interfaceRoles（master/slave/monitor/driver 等）、licenseStatus（identified/unknown/restricted）、confidence（0 到 1）。不能确定时保留原值或使用 unknown，不得编造。\n输入：${JSON.stringify(batch)}`
        const settled = client.waitForEvent((event) => event.type === 'agent_settled', 15 * 60_000)
        await Promise.all([
          client.command({ type: 'prompt', message: prompt, streamingBehavior: 'followUp' }, 15 * 60_000),
          settled
        ])
        if (processError) throw new Error(processError)
        const completeText = await finalAssistantText()
        const firstBracket = completeText.indexOf('[')
        const lastBracket = completeText.lastIndexOf(']')
        try {
          if (firstBracket < 0 || lastBracket <= firstBracket) throw new Error('响应中没有完整 JSON 数组')
          const parsed = JSON.parse(completeText.slice(firstBracket, lastBracket + 1)) as unknown
          if (!Array.isArray(parsed)) throw new Error('Pi 返回的语义分析结果不是 JSON 数组')
          const expectedIds = new Set(batch.map((item) => item.id))
          results.push(...parsed.filter((item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === 'object' && expectedIds.has(String((item as Record<string, unknown>).id ?? ''))
          ))
        } catch (error) {
          if (batch.length > 1) {
            const middle = Math.ceil(batch.length / 2)
            await analyzeBatch(batch.slice(0, middle))
            await analyzeBatch(batch.slice(middle))
            return
          }
          if (!singleRetry) {
            await analyzeBatch(batch, true)
            return
          }
          throw new Error(`IP ${batch[0]?.id ?? 'unknown'} 的 JSON 响应不完整：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (let offset = 0; offset < compact.length; offset += 10) {
        await analyzeBatch(compact.slice(offset, offset + 10))
      }
      return { model: `${provider.id} / ${modelId}`, ips: results as ReturnType<AgentService['analyzeIpLibrary']> extends Promise<infer R> ? R extends { ips: infer I } ? I : never : never }
    } catch (error) {
      throw new Error(`Pi 语义分析失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      client.dispose()
      rmSync(providerFile, { force: true })
      rmSync(sessionFile, { force: true })
    }
  }

  /**
   * 列出项目的所有可用会话
   */
  async listSessions(projectId: string): Promise<SessionSummary[]> {
    const dir = this.sessionDir(projectId)
    const summaries: SessionSummary[] = []
    const active = this.sessions.get(projectId)
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`[agent-service] 项目不存在: ${projectId}`)
    const phaseMainName = phaseMainSessionName(project.currentPhase)

    try {
      const files = readdirSync(dir)

      for (const f of files) {
        if (!f.endsWith('.jsonl') || f.endsWith('.bak.jsonl')) continue
        const filePath = join(dir, f)
        const logicalName = sessionNameFromFile(filePath)
        // 其他阶段及旧版跨阶段 session.jsonl 只保留在磁盘，不进入当前阶段会话列表。
        if (!sessionBelongsToPhase(logicalName, project.currentPhase)) continue
        const name = logicalName === phaseMainName ? 'main' : logicalName
        let messageCount = 0
        let label = name === 'main' ? `${project.currentPhase} 主会话` : name
        try {
          const content = readFileSync(filePath, 'utf-8')
          const lines = content.trim().split(/\n/).filter(l => l.trim().length > 0)
          for (const line of lines) {
            if (line.includes('"type":"message"')) {
              messageCount += 1
              continue
            }
            if (!line.includes('"type":"session_info"')) continue
            try {
              const entry = JSON.parse(line) as { type?: string; name?: string }
              if (entry.type === 'session_info' && entry.name) label = entry.name
            } catch { /* 忽略损坏的单行，保留文件名作为展示名 */ }
          }
        } catch { /* 忽略 */ }
        const storedModel = this.modelStore.get(projectId, logicalName)
        summaries.push({
          name,
          file: filePath,
          label,
          messageCount,
          modelLabel: storedModel ? `${storedModel.providerId} / ${storedModel.modelId}` : '',
          selectedModel: storedModel ?? null,
          isActive: active ? active.currentSessionFile === filePath : false
        })
      }
    } catch { /* 无可枚举的会话目录 */ }

    // 按修改时间排序（最新的在前）
    summaries.sort((a, b) => a.name === 'main' ? -1 : b.name === 'main' ? 1 : b.name.localeCompare(a.name))
    return summaries
  }

  /** 切换活动会话。正在生成的旧会话转入后台，保持其 Agent 进程继续运行。 */
  async switchSession(projectId: string, sessionName: string): Promise<AgentSessionInfo> {
    const current = this.sessions.get(projectId)
    if (!current) throw new Error('[agent-service] 进程未建立')
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`[agent-service] 项目不存在: ${projectId}`)

    const logicalSessionName = sessionName === 'main'
      ? phaseMainSessionName(project.currentPhase)
      : sessionName
    if (!sessionBelongsToPhase(logicalSessionName, project.currentPhase)) {
      throw new Error(`不能在 ${project.currentPhase} 阶段载入其他阶段的会话历史`)
    }

    const targetFile = resolve(join(this.sessionDir(projectId), `session-${logicalSessionName}.jsonl`))
    if (!existsSync(targetFile)) throw new Error(`[agent-service] 会话文件不存在: ${targetFile}`)
    if (resolve(current.currentSessionFile) === targetFile) {
      this.modelStore.setActiveSession(projectId, current.activeSessionName)
      return {
        projectId,
        phase: current.phase,
        sessionName: current.activeSessionName,
        isStreaming: current.isStreaming,
        modelLabel: current.modelLabel,
        selectedModel: current.selectedModel,
        providersReady: true
      }
    }

    this.flushStreamEvents(projectId)
    this.sessions.delete(projectId)
    if (current.isStreaming) {
      this.backgroundFor(projectId).set(resolve(current.currentSessionFile), current)
    } else {
      current.client.dispose()
    }

    const background = this.backgroundFor(projectId)
    let session = background.get(targetFile)
    if (session) {
      background.delete(targetFile)
      if (background.size === 0) this.backgroundSessions.delete(projectId)
      this.sessions.set(projectId, session)
    } else {
      const storedLabel = this.storedSessionLabel(targetFile)
      session = this.spawnSession(projectId, project.currentPhase, project.name, targetFile)
      await session.client.waitReady()

      const providers = this.readyProviders()
      const targetSessionName = sessionNameFromFile(targetFile)
      const preferred = this.modelStore.get(projectId, targetSessionName)
      const initial = preferred && providers.some(
        (provider) => provider.id === preferred.providerId && provider.models.includes(preferred.modelId)
      )
        ? preferred
        : { providerId: providers[0].id, modelId: providers[0].models[0] }
      await this.setModelInternal(session, initial.providerId, initial.modelId)
      this.modelStore.set(projectId, session.activeSessionName, initial.providerId, initial.modelId)
      if (storedLabel) {
        await session.client.command({ type: 'set_session_name', name: storedLabel })
      }
    }

    this.modelStore.setActiveSession(projectId, session.activeSessionName)

    return {
      projectId,
      phase: session.phase,
      sessionName: session.activeSessionName,
      isStreaming: session.isStreaming,
      modelLabel: session.modelLabel,
      selectedModel: session.selectedModel,
      providersReady: true
    }
  }

  async closeSession(projectId: string, sessionName: string): Promise<AgentSessionInfo> {
    if (sessionName === 'main') throw new Error('阶段主会话不可关闭')
    if (!sessionName || /[\\/]/.test(sessionName)) throw new Error('无效的会话名称')

    const session = this.sessions.get(projectId)
    if (!session) throw new Error('[agent-service] 进程未建立')
    const phaseMainName = phaseMainSessionName(session.phase)
    if (sessionName === phaseMainName) throw new Error('阶段主会话不可关闭')
    const dir = resolve(this.sessionDir(projectId))
    const targetFile = resolve(dir, `session-${sessionName}.jsonl`)
    if (dirname(targetFile) !== dir) throw new Error('会话路径越界')
    if (!existsSync(targetFile)) throw new Error(`会话文件不存在: ${targetFile}`)

    let info: AgentSessionInfo
    if (resolve(session.currentSessionFile) === targetFile) {
      info = await this.switchSession(projectId, phaseMainName)
    } else {
      const background = this.backgroundSessions.get(projectId)
      const backgroundSession = background?.get(targetFile)
      if (backgroundSession) {
        backgroundSession.client.dispose()
        background?.delete(targetFile)
        if (background?.size === 0) this.backgroundSessions.delete(projectId)
      }
      info = await this.ensureSession(projectId)
    }
    rmSync(targetFile, { force: true })
    this.modelStore.delete(projectId, sessionNameFromFile(targetFile))
    return info
  }

  async abort(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session) return
    try {
      await session.client.command({ type: 'abort' }, 5_000)
      session.isStreaming = false
      this.flushStreamEvents(projectId)
      return
    } catch (error) {
      console.warn('[agent-service] Pi 中止命令未及时响应，重启当前会话进程', error)
    }

    const project = this.projects.get(projectId)
    if (!project) throw new Error(`[agent-service] 项目不存在: ${projectId}`)
    const selectedModel = session.selectedModel
    const sessionFile = session.currentSessionFile
    this.sessions.delete(projectId)
    session.client.dispose()

    const replacement = this.spawnSession(projectId, session.phase, project.name, sessionFile)
    await replacement.client.waitReady()
    if (selectedModel) {
      await this.setModelInternal(replacement, selectedModel.providerId, selectedModel.modelId)
    }
    replacement.isStreaming = false
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
    this.modelStore.set(projectId, session.activeSessionName, providerId, modelId)
    return {
      projectId,
      phase: session.phase,
      sessionName: session.activeSessionName,
      isStreaming: false,
      modelLabel: session.modelLabel,
      selectedModel: session.selectedModel,
      providersReady: true
    }
  }

  async getMessages(projectId: string): Promise<AgentUiMessage[]> {
    const session = this.sessions.get(projectId)
    if (!session) return []
    // Session JSONL 是持久化事实源。直接读取它可以避免长任务期间 Pi RPC 忙碌，
    // 也不会因 get_messages 超时把整个工作区拖入错误状态。
    const data = { messages: this.readSessionMessages(session.currentSessionFile) }
    const toolInputs = new Map<string, { toolName: string; input: string }>()
    for (const message of data.messages) {
      if (message.role !== 'assistant') continue
      const blocks = (message.content as Array<Record<string, unknown>> | undefined) ?? []
      for (const block of blocks) {
        if (block.type !== 'toolCall') continue
        const callId = String(block.id ?? '')
        if (!callId) continue
        toolInputs.set(callId, {
          toolName: String(block.name ?? 'tool'),
          input: this.formatToolInput(block.arguments)
        })
      }
    }
    const mapped = data.messages.flatMap((message, index) => this.mapMessage(message, index, toolInputs))
    if (mapped.length <= UI_HISTORY_MAX) return mapped
    return [
      {
        id: `history-window-${mapped.length}`,
        role: 'assistant',
        text: `为保持长会话界面稳定，当前仅显示最近 ${UI_HISTORY_MAX} 条记录；完整历史仍保存在 Session 文件中。`,
        timestamp: mapped.at(-UI_HISTORY_MAX)?.timestamp ?? Date.now()
      },
      ...mapped.slice(-UI_HISTORY_MAX)
    ]
  }

  async getSessionStats(projectId: string): Promise<AgentSessionStats | null> {
    const session = this.sessions.get(projectId)
    if (!session) return null
    try {
      const stats = await session.client.command<AgentSessionStats>({ type: 'get_session_stats' }, 5_000)
      const metadata = session.selectedModel ? resolveModelContext(session.selectedModel.modelId) : null
      if (!metadata) {
        delete stats.contextUsage
        stats.contextWindowStatus = 'unknown'
        return stats
      }
      stats.contextWindowStatus = metadata.verified ? 'verified' : 'estimated'
      stats.contextWindowSource = metadata.source
      if (stats.contextUsage) {
        stats.contextUsage.contextWindow = metadata.contextWindow
        stats.contextUsage.percent = stats.contextUsage.tokens == null
          ? null
          : Math.min(100, (stats.contextUsage.tokens / metadata.contextWindow) * 100)
      }
      return stats
    } catch (error) {
      console.warn('[agent-service] 获取会话用量失败', error)
      return null
    }
  }

  private readSessionMessages(sessionFile: string): PiMessage[] {
    if (!existsSync(sessionFile)) return []
    const messages: PiMessage[] = []
    for (const line of readFileSync(sessionFile, 'utf-8').split(/\r?\n/)) {
      if (!line.includes('"type":"message"')) continue
      try {
        const entry = JSON.parse(line) as { type?: string; message?: PiMessage }
        if (entry.type === 'message' && entry.message) messages.push(entry.message)
      } catch {
        // 流式写入时末行可能尚未完整，忽略后等待下一次读取。
      }
    }
    return messages
  }

  private observeWatchdogEvent(
    projectId: string,
    session: PiSession,
    event: Record<string, unknown>
  ): void {
    if (this.sessions.get(projectId) !== session || !session.isStreaming) return
    let action: WatchdogAction | null = null
    if (event.type === 'tool_execution_start') {
      action = session.watchdog.start(
        String(event.toolCallId ?? ''),
        String(event.toolName ?? ''),
        event.args ?? event.input ?? event.arguments
      )
    } else if (event.type === 'tool_execution_end') {
      action = session.watchdog.end(String(event.toolCallId ?? ''), Boolean(event.isError))
    }
    if (!action || session.watchdogActionPending) return
    session.watchdogActionPending = true

    if (action.level === 'abort') {
      this.flushStreamEvents(projectId)
      this.emit(projectId, {
        type: 'error',
        message: `MoonGlass 已触发 Agent 循环熔断：${action.reason}\n${action.instruction}`
      })
      void session.client.command({ type: 'abort' }, 5_000)
        .catch((error) => console.warn('[agent-service] Watchdog 中止命令失败', error))
        .finally(() => {
          session.isStreaming = false
          session.watchdogActionPending = false
        })
      return
    }

    this.emit(projectId, {
      type: 'status',
      message: `MoonGlass 检测到执行正在退化：${action.reason}，已要求 Agent 切换收敛策略。`
    })
    void session.client.command({
      type: 'prompt',
      message: `[MoonGlass Watchdog]\n原因：${action.reason}\n恢复要求：${action.instruction}`,
      streamingBehavior: 'steer'
    }, 15_000)
      .catch((error) => console.warn('[agent-service] Watchdog steer 失败', error))
      .finally(() => { session.watchdogActionPending = false })
  }

  // ==================== pi 事件 → AgentStreamEvent ====================

  private handlePiEvent(projectId: string, event: Record<string, unknown>): void {
    const type = event.type as string
    switch (type) {
      case 'agent_start':
        this.flushStreamEvents(projectId)
        this.emit(projectId, { type: 'agent-start' })
        break
      case 'agent_settled':
        this.flushStreamEvents(projectId)
        this.emit(projectId, { type: 'agent-settled' })
        break
      case 'message_update': {
        const delta = (event.assistantMessageEvent ?? {}) as Record<string, unknown>
        if (delta.type === 'text_delta') {
          this.queueStreamEvent(projectId, { type: 'text-delta', delta: String(delta.delta ?? '') })
        } else if (delta.type === 'thinking_delta') {
          this.queueStreamEvent(projectId, { type: 'thinking-delta', delta: String(delta.delta ?? '') })
        } else if (delta.type === 'error') {
          // Pi 0.84+ 的 RPC 只发送增量事件，不再携带累计 message/partial。
          // 保留旧字段回退，以兼容历史测试和旧版事件录制。
          const partial = (delta.partial ?? event.message ?? {}) as Record<string, unknown>
          this.emit(projectId, {
            type: 'error',
            message: String(delta.errorMessage ?? delta.error ?? partial.errorMessage ?? 'LLM 请求失败')
          })
        }
        break
      }
      case 'tool_execution_start':
        this.flushStreamEvents(projectId)
        this.emit(projectId, {
          type: 'tool-start',
          toolName: String(event.toolName ?? ''),
          toolCallId: String(event.toolCallId ?? ''),
          input: this.formatToolInput(event.args ?? event.input ?? event.arguments)
        })
        break
      case 'tool_execution_end': {
        this.flushStreamEvents(projectId)
        const result = (event.result ?? {}) as { content?: Array<{ text?: string }> }
        const output = (result.content ?? []).map((c) => c.text ?? '').join('\n')
        this.emit(projectId, {
          type: 'tool-end',
          toolName: String(event.toolName ?? ''),
          toolCallId: String(event.toolCallId ?? ''),
          isError: Boolean(event.isError),
          output: output.length > TOOL_OUTPUT_MAX ? output.slice(0, TOOL_OUTPUT_MAX) + '\n…（截断）' : output,
          decisionRequest: parseDecisionRequest(output)
        })
        break
      }
      case 'tool_execution_update': {
        // 长耗时工具（如 run_simulation）的中间进度：转发给渲染层，避免界面长时间无反馈被误判为“中止”。
        const partial = (event.partialResult ?? event.partial ?? {}) as { content?: Array<{ text?: string }> }
        const text = (partial.content ?? []).map((c) => c.text ?? '').join('\n')
        this.emit(projectId, {
          type: 'tool-update',
          toolName: String(event.toolName ?? ''),
          toolCallId: String(event.toolCallId ?? ''),
          text: text.length > TOOL_OUTPUT_MAX ? text.slice(0, TOOL_OUTPUT_MAX) + '\n…（截断）' : text
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

  private formatToolInput(input: unknown): string {
    if (input === undefined || input === null) return ''
    if (typeof input === 'string') return input
    try {
      return JSON.stringify(input, null, 2)
    } catch {
      return String(input)
    }
  }

  private mapMessage(
    m: PiMessage,
    index: number,
    toolInputs: Map<string, { toolName: string; input: string }>
  ): AgentUiMessage[] {
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
      return text ? [{
        id,
        role: 'user',
        text,
        timestamp: ts,
        decisionResponse: parseDecisionResponse(text),
        decisionResponses: parseDecisionResponses(text)
      }] : []
    }

    if (m.role === 'assistant') {
      const blocks = (m.content as Array<Record<string, unknown>> | undefined) ?? []
      const out: AgentUiMessage[] = []
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n')
      const thinking = blocks
        .filter((block) => block.type === 'thinking')
        .map((block) => String(block.thinking ?? ''))
        .join('\n')
      if (text || thinking) {
        out.push({
          id,
          role: 'assistant',
          text,
          thinking: thinking || undefined,
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
      const toolInput = m.toolCallId ? toolInputs.get(m.toolCallId) : undefined
      return [
        {
          id,
          role: 'tool',
          toolName: m.toolName,
          toolCallId: m.toolCallId,
          toolInput: toolInput?.input,
          isError: m.isError,
          text: text.length > TOOL_OUTPUT_MAX ? text.slice(0, TOOL_OUTPUT_MAX) + '\n…（截断）' : text,
          timestamp: ts,
          decisionRequest: parseDecisionRequest(text)
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
