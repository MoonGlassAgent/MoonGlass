/**
 * Agent 会话服务（Phase 2）
 *
 * 以 RPC 模式嵌入真实 Pi Coding Agent（@earendil-works/pi-coding-agent）：
 * 每个项目一个 pi 子进程（`pi --mode rpc`），cwd 为项目工作目录，
 * 系统提示词经 `.pi/APPEND_SYSTEM.md` 注入（buildSystemPrompt 按阶段组装），
 * Provider 配置经桥接扩展 + MOONGLASS_PROVIDERS_JSON 环境变量注入。
 *
 * 会话模型：每个项目以 projectId 隔离一个主会话和若干平行会话。阶段推进/回退、
 * 关闭重开默认延续当前项目的主会话；阶段切换需重启进程以加载新系统提示词。
 * 平行会话拥有独立历史，可在同一项目内创建和切换。
 *
 * TODO(Phase 4): 芯片工具集以 pi 扩展注册；按阶段限制工具白名单
 *                （当前使用 pi 默认的 read/write/edit/bash 四工具，不做限制）。
 * TODO(打包): electron-builder 打包时需把 pi 依赖与桥接扩展纳入 extraResources。
 */

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  /** 切走后仍在执行的会话进程，按项目和会话文件保存。 */
  private backgroundSessions = new Map<string, Map<string, PiSession>>()
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
      const src = app.isPackaged
        ? join(resourcesDir, 'pi-bridge', 'eda-bridge', name)
        : join(resourcesDir, 'packages', 'eda-bridge', 'src', name)
      if (existsSync(src)) copyFileSync(src, join(edaBridgeDir, name))
      else console.error(`[agent-service] 未找到 EDA 桥接源文件: ${src}`)
    }
    copyEda('tool-runner.ts')
    copyEda('simulation.ts')
    copyEda('synthesis.ts')

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
- 进入验证实现前必须先使用 \`verification-planning\`，随后使用 \`cocotb-verification\`。
- RTL 只写入 \`rtl/\`；Lint/CDC 报告分别写入 \`rtlqa/lint/\` 和 \`rtlqa/cdc/\`。
- RTL 阶段必须维护 \`rtl/design.json\` 和 \`rtl/filelist.f\`：design.json 的 filelist 写字符串 \`"filelist.f"\`，源文件顺序逐行写入 filelist.f，并明确 topModule、includeDirs 与 defines。
- 默认假设没有可用 SRAM/ROM 宏。若架构需要存储宏，先在 \`docs/03_design/architecture.md\` 记录组织、端口、时序、面积/功耗估算和替换责任，再把存储体从控制器剥离为参数化 bank 级宏接口。
- 存储宏三视图写入 \`rtl/macros/\`：\`sram_behavioral.v\` 仅仿真，\`sram_blackbox.v\` 仅综合并用 \`read_verilog -lib\`，\`sram_phy_template.v\` 仅作物理宏例化/端口映射交付物。三者不得在同一次工具调用中作为普通 RTL 同时读入。
- \`rtl/design.json\` 用 \`simulationFiles\`、\`libraryFiles\`、\`physicalFiles\` 分别登记三类视图；\`filelist.f\` 仅放控制逻辑和其他普通设计源。宏面积/功耗按架构或数据手册单独报告，不得伪装成 Yosys 标准单元面积。
- Agent 新生成的 RTL 默认符合 Verilog-2001 并使用 \`.v\`；生成的验证断言可使用 SystemVerilog/SVA。此生成约束不得用于拒绝或改写用户导入的较新标准代码。
- 仿真日志、机器可读结果、覆盖率与波形必须写入 \`verification/results/<module>/\`。
- Cocotb 是默认验证执行方式：调用 \`run_simulation\` 时使用 \`mode="cocotb"\`、Python 模块名 \`testModule\` 和环境根目录 \`testDir\`；Windows 默认选 \`simulator="icarus"\`。除非兼容已有 C++ testbench，不得使用 cpp 模式或自行生成临时 runner 绕过工具。
- SDC 写入 \`imp/constraints/\`；网表、综合日志、时序和面积报告写入 \`imp/synthesis/\`。
- 综合默认使用本机 Nangate45 / FreePDK45 typical 开源 Liberty；用户未指定其他库时不要省略默认库。
- MoonGlass 工艺库统一索引路径：${processLibraryIndex.replace(/\\/g, '/')}。涉及工艺选择、综合、时序或物理视图前，先读取该索引并核对 Liberty/LEF/GDS/Verilog 等可用文件；不得只凭目录名猜测文件。用户新增或下载工艺库后，以该索引为准。
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

1. 使用 verification-planning 技能维护 docs/04_verification/ 三份计划。
2. 使用 collect_rtl_files、read_verilog、run_verible_lint 和 check_synthesizability。
3. 使用 cocotb-verification 技能在 verification/$1_tb/ 创建规范环境。
4. 完善 Cocotb 测试后，使用 run_simulation(mode="cocotb", testModule=..., testDir=..., simulator="icarus") 实际运行。
5. 确认 verification/results/$1/ 中存在编译日志、仿真日志、result.json 和波形。
6. 更新需求到测试的追踪、覆盖率结果和 docs/06_validation/ 验证报告。
7. 工具失败时分析日志、修复并重跑；不得以文字结论代替实际工具结果。
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
      onEvent: (event) => {
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
      this.disposeBackgroundSessions(projectId)
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
    let fileName = `session-${safeName}.jsonl`
    let newFile = join(this.sessionDir(projectId), fileName)
    if (existsSync(newFile)) {
      fileName = `session-${safeName}-${Date.now().toString(36)}.jsonl`
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
      return await this.switchSession(projectId, fileName.slice(0, -'.jsonl'.length))
    } catch (error) {
      rmSync(newFile, { force: true })
      throw error
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
        const name = f === 'session.jsonl' ? 'main' : f.slice(0, -'.jsonl'.length)
        const filePath = join(dir, f)
        let messageCount = 0
        let label = name === 'main' ? '主会话' : name
        try {
          const { readFileSync } = require('node:fs') as typeof import('node:fs')
          const content = readFileSync(filePath, 'utf-8')
          const lines = content.trim().split(/\n/).filter(l => l.trim().length > 0)
          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as { type?: string; name?: string }
              if (entry.type === 'session_info' && entry.name) label = entry.name
              if (entry.type === 'message') messageCount += 1
            } catch { /* 忽略损坏的单行，保留文件名作为展示名 */ }
          }
        } catch { /* 忽略 */ }
        summaries.push({
          name,
          file: filePath,
          label,
          messageCount,
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

    const targetFile = resolve(sessionName === 'main'
      ? this.sessionFilePath(projectId)
      : join(this.sessionDir(projectId), `${sessionName}.jsonl`))
    if (!existsSync(targetFile)) throw new Error(`[agent-service] 会话文件不存在: ${targetFile}`)
    if (resolve(current.currentSessionFile) === targetFile) {
      const state = await current.client.command<{ isStreaming?: boolean }>({ type: 'get_state' })
      return {
        projectId,
        phase: current.phase,
        isStreaming: state.isStreaming ?? false,
        modelLabel: current.modelLabel,
        selectedModel: current.selectedModel,
        providersReady: true
      }
    }

    const currentState = await current.client
      .command<{ isStreaming?: boolean }>({ type: 'get_state' })
      .catch(() => ({ isStreaming: false }))
    this.sessions.delete(projectId)
    if (currentState.isStreaming) {
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
      const preferred = current.selectedModel ?? this.modelStore.get(projectId)
      const initial = preferred && providers.some(
        (provider) => provider.id === preferred.providerId && provider.models.includes(preferred.modelId)
      )
        ? preferred
        : { providerId: providers[0].id, modelId: providers[0].models[0] }
      await this.setModelInternal(session, initial.providerId, initial.modelId)
      if (storedLabel) {
        await session.client.command({ type: 'set_session_name', name: storedLabel })
      }
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

  async closeSession(projectId: string, sessionName: string): Promise<AgentSessionInfo> {
    if (sessionName === 'main') throw new Error('主会话不可关闭')
    if (!sessionName || /[\\/]/.test(sessionName)) throw new Error('无效的会话名称')

    const session = this.sessions.get(projectId)
    if (!session) throw new Error('[agent-service] 进程未建立')
    const dir = resolve(this.sessionDir(projectId))
    const targetFile = resolve(dir, `${sessionName}.jsonl`)
    if (dirname(targetFile) !== dir) throw new Error('会话路径越界')
    if (!existsSync(targetFile)) throw new Error(`会话文件不存在: ${targetFile}`)

    let info: AgentSessionInfo
    if (resolve(session.currentSessionFile) === targetFile) {
      info = await this.switchSession(projectId, 'main')
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
    return info
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
