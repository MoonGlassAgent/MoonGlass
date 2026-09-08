# MoonGlass 开发进度说明 — v0.3（交接版）

> **日期**：2026-07-29
> **读者**：后续接手开发的团队
> **前置文档**：`docs/dev-summary-v0.1.md`（架构骨架）、`docs/dev-summary-v0.2.md`（Phase 2 对话闭环 + 决策记录）
> **设计依据**：`ChipForge_Studio_Specification.md`（唯一权威）

---

## 1. 一句话现状

MoonGlass（芯片开发全流程 AI 工作台，Electron 桌面应用）已完成**架构骨架、LLM Provider
配置、Agent 对话闭环（真实 Pi Coding Agent 内核）、门禁检查系统（真实 EDA 工具）、
工作区文件树**。工程已纳入 git 管理，`typecheck / build / dev / 冒烟脚本` 全部通过。
下一步是 **Phase 4：芯片工具集注入 Agent + 仿真/覆盖率链**。

## 2. 版本与 git 历史

项目于 2026-07-29 才初始化 git（此前两次接力开发均无 VCS，曾丢过一次代码，务必保持提交习惯）。

| commit | 内容 |
|--------|------|
| `df1bb97` | v0.2 基线：骨架 + Provider 配置 + Pi Agent 对话闭环（含另一团队增量：阶段会话文件、AgentModelStore、思考过程展示、E2E 脚本） |
| `439ff03` | 会话模型重构：**单会话文件跨阶段连续** + 「新会话」入口 |
| `6d79d3d` | **Phase 3：门禁检查接入真实 EDA 工具**（lint / yosys） |
| `a1807d5` | 工作区文件树 + 选项卡文件查看 + logo + `start-moonglass.bat` |

## 3. 已实现功能清单

| 模块 | 功能 | 状态 |
|------|------|------|
| 工程基座 | electron-vite + pnpm monorepo（根 + 3 子包）、Tailwind v4、zustand | ✅ |
| 领域模型 | 6 阶段枚举、ChipProject、门禁规则表（规格书 §3.1）、IPC 契约（三端唯一来源） | ✅ |
| 提示词系统 | `@moonglass/prompts`：全局/阶段/安全五段式 `buildSystemPrompt()` | ✅ |
| 项目管理 | CRUD + 6 阶段状态机推进/回退（SQLite + JSON 备份） | ✅ |
| LLM 配置 | 设置页「模型服务」：8 家预置 + 自定义，Key/URL/模型列表，JSON 持久化 | ✅ |
| Agent 对话 | **真实 Pi Coding Agent（RPC 子进程）**：流式输出、工具调用（read/write/edit/bash）、思考过程折叠展示、模型切换/持久化、单会话跨阶段连续、可手动「新会话」 | ✅ |
| 门禁系统 | 推进阶段时真实执行检查，**Error 级失败阻断**；lint（verible 优先/verilator 回退）、yosys 可综合性已接真；其余检查项 info 占位不阻塞 | ✅ |
| 文件树 | 工作区左侧自动扫描工作目录、折叠目录、Agent 运行结束自动刷新；双击文件选项卡只读查看 | ✅ |
| Python 引擎 | spawn + 超时（脚本页/工作区底部可冒烟） | ✅ |
| EDA 探测 | 设置页扫描 PATH 中 EDA 工具 | ✅ |
| 界面 | 全局明亮主题、品牌 logo（侧边栏 + 窗口图标） | ✅ |
| 芯片工具集 | 15 个工具名称/schema 已注册，handler 全为桩 | 🚧 Phase 4 |
| 仿真/覆盖率/CDC | 未开始 | 🚧 Phase 4 |
| IP 模板库/知识库 | 目录占位 | 🚧 Phase 5 |
| drizzle/sqlite | schema 已定义未接线（现 JSON 存储） | 📐 遗留 |

## 4. Agent 架构（核心认知）

```
渲染进程 ChatPanel ←IPC 事件→ AgentService（主进程）→ spawn `pi --mode rpc` 子进程 → LLM API
                                        │
                                        ├─ Provider 注入：env MOONGLASS_PROVIDERS_JSON + pi 桥接扩展（-e 加载）
                                        ├─ 提示词注入：工作目录 .pi/APPEND_SYSTEM.md（仅进程启动时读取！）
                                        ├─ 会话文件：pi-sessions/<projectId>/session.jsonl（跨阶段/重开连续）
                                        └─ cwd：workspaces/<projectId>/（= 文件树与门禁扫描的同一目录）
```

- 用户对话的是 **Pi（Agent 内核）**，Pi 再调用设置的模型；模型只出文本，工具执行靠 Pi。
- **阶段切换会秒级重启 pi 进程**（系统提示词只能启动时读），但会话文件不变、对话无缝。
- 芯片工具（Phase 4）应以 **pi 扩展**形式注入（参考 `resources/moonglass/pi-bridge/` 的写法 +
  pi 官方 extensions 文档），不要自研 agent loop。

## 5. 环境与坑（必读，都是真实踩过的）

1. **`ELECTRON_RUN_AS_NODE=1`**：spawn pi 必须带此 env，否则 Electron 二进制不执行脚本直接闪退。
2. **pi 是纯 ESM 包**：`require.resolve` 不可用，`AgentService.resolvePiBin()` 从 `__dirname` 向上探测。
3. **RPC 分帧**：只按 `\n` 切分剥 `\r`，禁用 Node readline（U+2028/2029 问题）。
4. **本机 EDA 工具链实情**：yosys ✅ / verilator ✅（oss-cad-suite），**verible ❌ 未安装**
   （lint 自动回退 verilator；装 verible 后自动切换）。
5. **oss-cad-suite 的 DLL 陷阱**：直接 spawn 会静默 127（与系统其他 mingw DLL 冲突），
   `synthesis.ts` 的 `toolEnv()` 会把套件 bin/lib 前置 PATH——新增 EDA 工具调用时复用此模式。
   `verilator` 本体是无扩展名脚本，要用 `verilator_bin.exe`（见 lint.ts 候选机制）。
6. **yosys 0.67 stat 是新表格式**（`6 wires`），非旧式 `Number of wires:`，解析已适配。
7. **重装依赖**：`ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" pnpm install`（默认源 GitHub 易失败）。
8. **pnpm-workspace.yaml**：`onlyBuiltDependencies` 与 `dangerouslyAllowAllBuilds` 互斥，已删前者，勿加回。
9. **electron-vite dev 的 HMR 只管渲染端**：改 `src/main`/`src/preload`/`src/shared` 必须重启 dev。
10. **Windows 保留名**：别在仓库根目录创建 `nul`/`con` 等文件名（shell 重定向 `>nul` 在 Git Bash 会真的建文件，曾挡死一次提交）。

## 6. 验证手段

```bash
pnpm typecheck        # 根 + 3 子包 tsc --noEmit
pnpm build            # 三端构建
pnpm dev              # 开发模式（或双击 start-moonglass.bat）
node scripts/eda-gate-smoke.mjs   # 门禁 12 项冒烟（不依赖 LLM，改 EDA 代码后必跑）
node scripts/pi-rpc-smoke.mjs     # pi RPC 协议冒烟（假 Key 验证到鉴权层）
node scripts/e2e-phase-history.mjs # E2E（playwright 驱动，需真实 Key，会消耗少量 token）
```

注意：`e2e-phase-history.mjs` 写于按阶段分会话文件的时期，其"历史保留"断言在单会话模型下
语义已变（同一会话天然全保留），脚本本身仍可运行但参考价值有限，建议 Phase 4 时重写。

## 7. 下一步：Phase 4（芯片专用工具集）

按优先级建议：

1. **工具以 pi 扩展注入 Agent**：`run_verible_lint`、`check_synthesizability` 已有 eda-bridge
   真实现，包一层 pi 扩展注册成 Agent 工具（阶段工具白名单见 `src/main/ai/agents/index.ts`，
   15 个工具 schema 在 `src/main/ai/tools/moonglass/`）。RTL Agent 即可"写代码→自查 lint→修复"闭环。
2. **仿真链**：verilator/iverilog 编译运行 + `run_simulation`、`parse_coverage`，
   补齐 VERIF→QA 的三个占位检查（行覆盖 ≥90% / 功能覆盖 ≥80% / 仿真通过）。
3. **端口一致性/接口提取**：`rtl-engine` 的 parser 桩接真，补 `port-consistency`。
4. `--autofix` 自动修复流（verible autofix / Agent 修复循环）。

其余遗留：API Key 迁移 safeStorage 加密（`LlmProviderService` 有 TODO）、
better-sqlite3 + drizzle 接线（schema 在 `src/main/data/schema/`）、
electron-builder 打包（pi 依赖需 extraResources）、消息 Markdown/代码高亮渲染、
文档类门禁检查（需文档管理功能）。

## 8. 快速上手

```bash
# 环境：Node ≥ 22（本机 v24.4.1）、pnpm ≥ 10（全局 10.30.3）
# EDA：oss-cad-suite（yosys/verilator）已在 PATH；可选装 verible
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
pnpm install
pnpm dev            # 或双击 start-moonglass.bat
```

使用前：设置 → 模型服务 → 启用 Provider 填 Key → 项目工作区开始对话。
改动守则见 `AGENTS.md`：契约唯一来源在 `src/shared/`、服务实现 `MoonGlassService` 接口、
未实现能力 `throw NotImplemented` + `TODO(Phase N)` 标注、禁止静默返回假数据。

---

*本文对应代码状态：commit `a1807d5`（main 分支），typecheck/build/门禁冒烟全通过。*
