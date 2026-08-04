# MoonGlass 阶段性开发总结 — v0.2（Phase 2 对话闭环 + 交接报告）

> **日期**：2026-07-29
> **阶段**：Phase 2（Agent 对话闭环）基本完成，待用户真实 Key 复测确认
> **依据**：`ChipForge_Studio_Specification.md`
> **前置文档**：`docs/dev-summary-v0.1.md`（架构骨架，v0.1）
> **读者**：接手开发的工作组。本文包含全部关键决策、当前状态、已知坑与下一步。

---

## 1. 项目一句话现状

MoonGlass（芯片开发全流程 AI 工作台，Electron 桌面应用）已完成架构骨架（v0.1）、
LLM Provider 配置管理、全局明亮主题，以及 **Phase 2：以真实 Pi Coding Agent 为内核的
Agent 对话闭环**。工程 `pnpm install → typecheck → build → dev` 全链路通过；
对话链路已通过协议级自动化冒烟验证，**真实 API Key 的端到端对话待复测**。

## 2. v0.2 新增功能

### 2.1 LLM Provider 配置管理（设置页「模型服务」）
- 预置 8 家 Provider：OpenAI、Anthropic、DeepSeek、Moonshot、Kimi Code、GLM 智谱、
  MiniMax、阿里云百炼；支持自定义新增/删除（预置不可删）。
- 每家可配：启用开关、Base URL、API Key（密码框）、模型列表（chip 增删）。
- 协议分两类：`openai-compatible`（7 家）/ `anthropic`（1 家），供请求分发。
- 持久化：`userData/moonglass/llm-providers.json`（首次启动以预置播种，用户改动优先）。
- 相关文件：`src/shared/llm-provider-presets.ts`、`src/main/services/LlmProviderService.ts`、
  `src/renderer/pages/SettingsPage.tsx`。

### 2.2 全局明亮主题
- 默认主题由暗色改为明亮（zinc 浅色系），覆盖全部 6 页面 + 组件（10 个渲染端文件）。
- `styles.css`：`color-scheme: light`，底色 `bg-zinc-100`；主进程窗口
  `backgroundColor: '#f4f4f5'`。

### 2.3 Phase 2：Pi Coding Agent 对话闭环
- **Agent 内核**：嵌入真实开源项目 Pi Coding Agent
  （`@earendil-works/pi-coding-agent@^0.82.1`，TS/Node 实现）。
- **集成方式**：主进程 spawn `pi --mode rpc` 子进程（JSONL over stdio），
  每个项目一个会话进程，进程隔离。
- **Provider 注入**：设置页配置经环境变量 `MOONGLASS_PROVIDERS_JSON` +
  pi 桥接扩展（`resources/moonglass/pi-bridge/moonglass-providers.ts`，
  启动时复制到 userData 供 `-e` 加载）注册进 pi，不污染 pi 全局配置。
- **提示词注入**：`buildSystemPrompt(phase)`（@moonglass/prompts，全局/阶段/安全
  五段式）写入项目工作目录 `.pi/APPEND_SYSTEM.md`，阶段切换时重写 + `new_session`。
- **Provider 配置热更新**：AgentService 维护配置指纹，设置页改过 Key/模型后
  重新进入工作区会自动重启 pi 进程加载新配置。
- **对话 UI**（工作区中部）：消息气泡（user/assistant/tool 折叠行）、流式输出、
  模型选择下拉（仅列已启用且配 Key 的）、发送/中止、未配置 Provider 引导卡片。
- 会话持久化由 pi 负责（JSONL，`userData/moonglass/pi-sessions/<projectId>/`），
  重进工作区经 `get_messages` 恢复历史。

## 3. 关键技术决策（含与规格书的偏差）

| 决策 | 结论 | 理由 |
|------|------|------|
| Pi Coding Agent 的形态 | **真实 Pi 是 Node/TS 项目，非规格书所写的 Python 子进程**。规格书 §3.2 描述（FastAPI/Jupyter）与实际 Pi 不符。用户已确认走真实 Pi 路线 | 规格书作者认知偏差；真实 Pi 自带 RPC/SDK、Provider 注册表、扩展机制，远比自研 Python 运行时划算 |
| 集成模式 | RPC 子进程（`pi --mode rpc`，JSONL）而非 SDK 进程内嵌入 | 进程隔离；协议有官方文档（rpc.md）；后续可替换内核 |
| Provider 注册 | `-e` 桥接扩展 + 环境变量注入，**不写** pi 的 `~/.pi/agent/models.json` | 避免污染用户全局配置；配置随进程生命周期 |
| 系统提示词 | 项目工作目录 `.pi/APPEND_SYSTEM.md`（pi 原生机制），spawn 加 `-a` 信任项目目录 | RPC 无 set_system_prompt 命令；该机制官方支持 |
| 阶段工具白名单 | Phase 2 不限制，用 pi 默认 read/write/edit/bash 四工具 | 芯片工具集 Phase 4 才接入，届时以 pi 扩展注册 |
| 消息渲染 | 纯文本 `whitespace-pre-wrap`，不引 Markdown 依赖 | 保持最小改动，后续可升级 |

## 4. 踩过的坑（接手必读）

1. **`ELECTRON_RUN_AS_NODE`（最重要的一个）**：主进程 `process.execPath` 是 Electron
   二进制而非 Node。spawn pi 子进程必须带 `ELECTRON_RUN_AS_NODE: '1'`，否则子进程
   当桌面应用启动、不执行脚本直接闪退（约 2 秒、零输出、exit 0），表现为
   「会话建立失败」。已在 `AgentService.spawnSession` 修复。
2. **pi 是纯 ESM 包**：`exports` 仅声明 `import` 条件且不含 `./package.json`，
   CJS 的 `require.resolve` 无法命中。`AgentService.resolvePiBin()` 改为从 `__dirname`
   向上探测 `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`。
3. **RPC 分帧**：必须只按 `\n` 切分并剥尾部 `\r`，**不能用 Node readline**
   （它会把 JSON 字符串内合法的 U+2028/U+2029 误判为换行）。见 `PiRpcClient.feed()`。
4. **项目资源信任**：pi 对 `.pi/` 项目资源默认 ask/忽略，RPC 模式需 `-a` 参数信任，
   否则 `APPEND_SYSTEM.md` 不生效。
5. **pnpm 配置冲突**（v0.1 遗留已修）：`pnpm-workspace.yaml` 中 `onlyBuiltDependencies`
   与 `dangerouslyAllowAllBuilds: true` 在 pnpm 10 下互斥，已删前者。
6. **Electron 二进制下载**：重装依赖时 postinstall 默认从 GitHub 下载易失败，需
   `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" pnpm install`。
7. **electron-vite dev 的 HMR 只覆盖渲染端**：改 `src/main`、`src/preload`、
   `src/shared` 后必须重启 `pnpm dev` 进程才生效。

## 5. 当前代码地图

```
src/
├── shared/
│   ├── types/moonglass.ts        # 全部领域类型（含 LlmProviderConfig、Agent* 类型）
│   ├── ipc-contract.ts           # IPC 通道 + MoonGlassApi（三端唯一契约源）
│   └── llm-provider-presets.ts   # 8 家预置 Provider
├── main/
│   ├── core/                     # lifecycle / application（服务注册表）
│   ├── services/
│   │   ├── ProjectService.ts     # 项目 CRUD（JSON 持久化）
│   │   ├── PhaseEngine.ts        # 6 阶段状态机
│   │   ├── PythonService.ts      # Python spawn 执行
│   │   ├── EdaService.ts         # EDA 工具探测
│   │   ├── LlmProviderService.ts # Provider 配置（JSON 持久化 + 预置播种）
│   │   └── AgentService.ts       # ★ Agent 会话：pi 进程生命周期/提示词注入/事件映射
│   ├── ai/
│   │   ├── agents/index.ts       # 6 阶段 Agent descriptor（提示词 ID + 工具白名单）
│   │   ├── runtime/pi/PiRpcClient.ts  # ★ pi RPC 协议客户端（JSONL 分帧）
│   │   └── tools/moonglass/      # 15 个芯片工具注册表（handler 全为桩）
│   ├── ipc.ts / index.ts         # handler 注册 / 入口（含 agent 事件推送注入）
├── preload/index.ts              # window.moonglass（含 agent.onEvent 订阅）
├── renderer/
│   ├── pages/                    # 6 页面（SettingsPage 含模型服务配置）
│   ├── components/ChatPanel.tsx  # ★ 对话面板（工作区中部）
│   ├── store/chatStore.ts        # ★ 对话状态（流式 delta 累加）
│   └── ...
packages/                         # prompts（完整）/ rtl-engine、eda-bridge（桩）
resources/moonglass/pi-bridge/    # ★ pi Provider 桥接扩展源码
scripts/pi-rpc-smoke.mjs          # ★ pi RPC 协议级冒烟脚本（可回归）
```

`userData/moonglass/` 运行时数据：`projects.json`、`llm-providers.json`、
`pi-bridge/`（桥接扩展副本）、`workspaces/<projectId>/`（含 `.pi/APPEND_SYSTEM.md`）、
`pi-sessions/<projectId>/`（pi 会话 JSONL）。

## 6. 验证状态

| 验证项 | 结果 |
|--------|------|
| `pnpm typecheck`（根 + 3 子包） | ✅ 零错误 |
| `pnpm build` | ✅ 三端通过（main ~39 kB / preload ~2.6 kB / renderer ~795 kB） |
| `pnpm dev` 启动 | ✅ 6 服务全启动（含 agent-service） |
| pi RPC 协议冒烟（`scripts/pi-rpc-smoke.mjs`，Electron 二进制 + 假 Key） | ✅ 握手/Provider 注册/set_model/流式事件全通 |
| 无 Key 引导卡片、错误气泡、配置热更新 | ✅ 代码审查级确认，UI 逻辑简单 |
| **真实 API Key 端到端对话** | ⚠️ **待复测**——用户配好 Key 后遭遇「下拉选模型失败」，已定位根因（坑 #1）并修复，修复后尚未经用户确认 |

## 7. 遗留事项（按优先级）

1. **复测确认**：真实 Key 下验证对话全链路（流式、工具调用、中止、阶段切换、历史恢复）。
2. **API Key 加密**：当前明文存 `llm-providers.json`，迁移 electron safeStorage
   （`LlmProviderService.ts` 有 TODO 标记）。
3. **门禁检查接真实 EDA 工具**（Phase 3–4）：`run_verible_lint`、`check_synthesizability`
   优先；芯片工具届时以 pi 扩展形式注册进 Agent。
4. **better-sqlite3 + drizzle 接线**（Phase 1 收尾）：schema 已备（`src/main/data/schema/`），
   替换 JSON 存储。
5. **IP 模板库内容导入**（Phase 5）：DDR_BIST、PSRAM、AXI 等（规格书 §8）。
6. 工程增强：**项目尚未初始化 git**（强烈建议尽快 `git init` 并提交基线）；
   electron-builder 打包配置（pi 依赖与桥接扩展需 extraResources）；ESLint/Prettier；
   消息 Markdown/代码高亮渲染；对话区思考过程（thinking-delta）展示。

## 8. 快速上手（接手方）

```bash
# 环境：Node ≥ 22（本机 v24.4.1）、pnpm ≥ 10（全局已装 10.30.3，store 在 D:\.pnpm-store）
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"   # 重装依赖时需要
pnpm install
pnpm dev          # 开发模式（改主进程/preload/shared 需重启）
pnpm typecheck && pnpm build

# pi RPC 协议回归（不依赖真实 Key，用假 Key 验证到 LLM 鉴权层）
node scripts/pi-rpc-smoke.mjs
```

对话功能使用前：设置 → 模型服务 → 选一个 Provider 填 API Key 并启用 →
进入项目工作区即可对话。改主进程代码后务必重启 `pnpm dev`（HMR 只管渲染端）。

---

*本总结对应代码状态：v0.2（Phase 2 对话闭环），typecheck/build 全通过。*
