# MoonGlass 待合入报告（2026-10-05）

面向对象：MoonGlass 原始开发团队（review / merge）
合入目标分支：待定（当前工作分支 `release/v0.9.8`）
合入基线：`1e9d265`（tag `v1.1.0`）
配套文档：[修改报告](./changes-2026-10-05.md)

---

## 1. 合入范围与状态

| 项 | 值 |
|---|---|
| 文件 | **21 个**（17 改 + 4 新增） |
| 代码量 | 已跟踪文件 **+571 / −74**；新增文件 **488 行**；合计 **+1059 / −74** |
| 提交状态 | **未提交**（工作区改动，按用户要求先试用） |
| 验证 | typecheck 全过 · root typecheck 11 项既有错误零新增 · core 35 项全过 · build 通过 |
| 适用版本 | v1.1.0 基线；**不适用于 v1.1.1 树**（该树已回退） |

---

## 2. 文件清单

### 2.1 新增（4）

| 文件 | 行数 | 作用 | 风险 |
|---|---:|---|---|
| `src/shared/verification-workbench.ts` | 186 | 工作台结论契约 + 纯投影构建器 | 低。纯函数、无副作用、无外部依赖 |
| `src/main/services/verification-evidence-reader.ts` | 77 | 当前 RTL 哈希 + 证据存在性/版本核对 | 低。只读；含路径越界防护 |
| `src/renderer/components/WorkbenchConclusion.tsx` | 120 | 结论卡组件 | 低。只读展示 |
| `scripts/verification-workbench-smoke.mjs` | 105 | 结论口径守门测试（已注册 core） | 无 |

### 2.2 修改（17）

| 文件 | +/− | 改动性质 | 审查重点 |
|---|---|---|---|
| `packages/verification-intelligence-engine/src/engine.ts` | +223/−35 | **语义变更（最大）** | `requirementModel` 重写；`refreshScenarioWithHits` 裁决时序守卫；新增 `readScenarioRegistrationTimes` 相关辅助 |
| `packages/verification-intelligence-engine/src/types.ts` | +20 | 契约扩展（纯追加可选字段） | `RequirementFact.references` / `citedIn`、`RequirementModel.unresolvedReferences`、`VerificationScenario.adjudicatedAt` |
| `src/main/services/verif-batch-verdict.ts` | +52/−9 | **语义变更** | `readScenarioRegistrationTimes` 取代纯集合判定；`judgeBatchCompletion` 新增 fresh/replayed |
| `src/main/services/AgentService.ts` | +33/−5 | **语义变更** | 两处删除 `\|\| postureFresh`；新增 `stopVerifRunLoopAndWait()` |
| `src/main/services/FileService.ts` | +12 | 纯追加 | 新增 `forceReleaseVerificationWatch()` |
| `src/main/ipc.ts` | +28 | 接线 + 流程 | `Phase.Reset` 前置停循环与释放监视器；新增 `Fs.VerificationWorkbench` handler |
| `src/shared/types/moonglass.ts` | +14/−2 | 契约扩展 | `VerifBatchVerdict` 新增两个可选字段并重写注释口径 |
| `src/shared/ipc-contract.ts` | +7 | 契约扩展 | 新增 `Fs.VerificationWorkbench` 通道与 `MoonGlassApi.fs.verificationWorkbench` |
| `src/preload/index.ts` | +1 | 接线 | 同上 |
| `src/shared/verification-guidance.ts` | +4/−1 | **语义变更（1 行）** | 签核步骤 `completed` → `running` |
| `src/renderer/pages/VerificationPosturePage.tsx` | +12/−6 | **语义变更** | 移除 `blockers === 0 ⇒ 就绪` 回退 |
| `src/renderer/pages/WorkspacePage.tsx` | +30/−10 | 修复 + 接线 | 页签阶段守卫；结论卡接入 `VerifStatusBar` |
| `src/renderer/i18n/locales/zh-CN/verification.ts` | +49/−2 | 文案 | 新增 `verification.workbench.*`；删死键 `signoff.readyLabel/readyDetail`，加 `unconfirmedLabel/Detail` |
| `src/renderer/i18n/locales/en/verification.ts` | +44/−2 | 文案 | 与 zh-CN 键集一致（`typeof` 约束会在 typecheck 强制） |
| `scripts/verif-batch-verdict-smoke.mjs` | +38/−1 | 测试 | 新增 4 组断言 |
| `scripts/verification-guidance-smoke.mjs` | +3/−1 | 测试 | 按新契约更新 1 条断言（原断言锁住了缺陷） |
| `scripts/run-tests.mjs` | +1 | 测试注册 | 注册新冒烟 |

---

## 3. 需要团队决策的口径问题（3 项）

这三项都是**方法学判断**，不是技术选择。当前实现取的是下面「建议」一列；若团队结论不同，改动量都不大（见各项影响面）。

### 3.1 文档角色与定义列约定

**现状**：按文件角色分配 ID 命名空间——`module_specification.md` 定义 `SPEC-*`，`product_requirements.md` 定义 `REQ-*`，`requirements_traceability.md` 视为**纯链接表、零义务**；表格中表头恰为 ID 列（`规格 ID`/`需求 ID`/`条款 ID`）的列是**定义列**，含"关联/追溯"字样的列是**引用列**。

**建议**：采纳。理由：这是把"每条可追随"落到实处的唯一方式——`SPEC-*` 与 `REQ-*` 各自回归自己的文档，追溯列只做链接，不重复定义对方义务。

**影响面**：仅 `requirementModel` 内的角色/列判定函数。若团队文档命名不同（例如把定义列命名为"编号"），只需扩展 `specDocRole` / `isDefinitionColumn` 两个正则。

### 3.2 「批次完成」是否应因证据重放而判失败

**现状**：`complete` **保持**为"批次会话契约"（全部场景有登记 + 态势已重建）。历史重放不改变 `complete`，但通过新增的 `replayedScenarioIds` 与结构化 reason 显式暴露。收敛由外层进展判定承担。

**建议**：采纳。理由：诊断类批次（只读旧失败证据 + 登记裁决 + 重建态势）按约定交付即为完成，若因重放判失败会**误杀合法路径**；真正的风险是"该契约单独无法区分重放与新增"，所以应把两者**分开表达**而不是合并成一个布尔。

**替代方案**（若团队认为空转必须立即熔断）：令 `replayedScenarioIds.length > 0` 进入 `breakers`。
代价：一进入诊断路径就熔断整个批次编排，需配套调整 `isDiagnosticStalled` 的触发条件。

### 3.3 条款正文取"验收类列"

**现状**：义务正文取验收类列（`验收标准`/`通过标准`/`关键约束`/`检查点`/`预期`），其余字段列（接口名/方向/位宽/时钟域/条件）不进入正文；分类（`clauseKind`/`channel`）与特征提取仍按**整行**。

**建议**：采纳。理由：字段值是记录，不是可判定断言；把它们拼进正文会生成无法验证的"义务"并永久停在未闭环。分类按整行是为了保住 PPA 通道口径（否则「输入时钟频率 200MHz」这类量值措辞会漏判，PPA 条款会误入 VERIF 完备性分母）。

**影响面**：`ACCEPTANCE_COLUMN` 正则；若团队有其他列名约定，补进该正则即可。

---

## 4. 已知影响与迁移注意

### 4.1 真实项目首次重建会改变场景结构（**需要人工确认**）

- 幻影义务对应的 `CLAUSE_DERIVED` 场景会**消失**（实测：小数分频器 59→46、GMAC 383→171）；
- 保留场景的**ID 稳定**（按条款序号哈希），但**正文收窄**了；
- 磁盘上 `verification/results/**/scenario_hits.json` 里的**旧 hit 会照旧算作通过**，
  由于场景语义已收窄，这些通过**可能偏乐观**。

**建议**：合入后在 1–2 个真实项目上重建，抽查关键场景的证据有效性，再推广。本轮**未触碰任何真实项目**（全部复现在临时目录）。

### 4.2 数据库 schema 版本已超前于代码（不阻塞）

- 真实库 `PRAGMA user_version = 4`，而回退后代码 `CURRENT_VERSION = 3`（v4 是 `ALTER TABLE chip_projects ADD COLUMN assembly_json`，来自已回退的系统项目功能）；
- `migrate.ts` 只执行 `version > current` 的迁移，**打开不会报错**，`assembly_json` 是永久孤儿列；
- 但 **v4 这个版本号已被占用**，将来重做系统项目时迁移编号需往后排。

### 4.3 运行时生效方式

- 引擎源文件在**开发态**由 `AgentService` 启动时复制到 `userData/moonglass/pi-bridge/verification-intelligence/`；
- **打包态**由 `electron-builder.yml` 的 `extraResources` 从 `packages/verification-intelligence-engine/src` 复制；
- 因此：`pnpm dev` / `start-moonglass.bat` 重启即生效；**已打包的 `dist/` 与 `green-dist-*/` 不含本轮改动**，需重新打包。

### 4.4 仓库状态提醒

- 本轮补了 `v1.1.0` 标签（此前只有提交信息里的"v1.1.0 基线"，无标签；`v0.9.8` 标签挂在 `origin/main` 公开线上，**不是**当前分支的祖先）；
- 被回退的 v1.1.1 树挂在 `ORIG_HEAD`（`82e6ea0`），仅靠 reflog 保护（未引用对象默认 30 天）。若团队需要长期对照，建议加一个临时引用（如 `wip/v1.1.1-reverted`）。

---

## 5. 建议的合入步骤

### 5.1 建议拆成 6 个提交（便于逐条审查）

1. `fix(engine)`: 解析内核重写（表感知 / 定义优先 / 一行一条义务 / 验收列 / 追溯链接）+ 裁决时序守卫
   —— `engine.ts`、`engine/types.ts`
2. `fix(agent)`: 进展只认闭环计数；批次完成判定分离新增证据与历史重放
   —— `AgentService.ts`、`verif-batch-verdict.ts`、`shared/types/moonglass.ts`
3. `feat(verif-ui)`: 验证工作台结论层（只读投影 + 证据核对 + 结论卡 + IPC）
   —— 4 个新增文件、`ipc.ts`、`ipc-contract.ts`、`preload/index.ts`、`WorkspacePage.tsx`、i18n
4. `fix(verif-ui)`: 移除两处虚假绿色（签核回退、签核步骤状态）
   —— `VerificationPosturePage.tsx`、`verification-guidance.ts`
5. `fix(phase)`: 阶段重置停稳循环 + 释放验证目录监视器；「验证运行」页签阶段守卫
   —— `ipc.ts`、`AgentService.ts`、`FileService.ts`、`WorkspacePage.tsx`
6. `test`: 冒烟新增与口径修订 —— 3 个脚本 + `run-tests.mjs`

> 注：第 3、5 项都改 `WorkspacePage.tsx`/`ipc.ts`，若团队偏好文件级原子提交，可合并为 3 个提交。

### 5.2 合入前验证（期望输出）

```bash
pnpm install
pnpm typecheck        # 5 个子包 Done
pnpm typecheck:root   # 恰好 11 项既有错误（与基线一致，零新增）
pnpm test             # core suite passed (35 scripts)
pnpm build            # 三端构建通过
```

### 5.3 建议补做（合入前或合入后尽快）

- [ ] **CHANGELOG-DEV.md**：本轮（2026-10-05）解析内核 + P0 + P1 + 三处缺陷修复均未记录，按仓库惯例应补；
- [ ] **三处缺陷修复补冒烟**：`forceReleaseVerificationWatch` / `stopVerifRunLoopAndWait` / 页签阶段守卫目前在 `scripts/` 中**零覆盖**；
- [ ] **`unresolvedReferences` 接入界面**：悬空引用（只被引用、从未在任何 ID 列定义）已结构化入库，但界面尚未渲染，见 §6。

---

## 6. 遗留 TODO（本轮未做，建议后续排期）

| 项 | 说明 |
|---|---|
| `unresolvedReferences` 未展示 | 已进入 `requirement-model.json`，但工作台快照不含它，界面看不到"被引用却从未定义"的 ID |
| 根类型检查 11 项 | v1.1.0 基线遗留（Electron `console-message` 参数、门禁字段、阶段证据类型、`findLast` 目标库）；曾在被回退的 10-03 提交里补齐，需重新决定是否摘取 |
| `assembly_json` 孤儿列 | 见 §4.2，需决定保留或清理 |
| 批次判定是否会话层与展示层口径一致性 | 本轮只统一了 `complete` 与进展；`isDiagnosticStalled` 的"本批无新尝试不算熔断"仍按原口径保留，未复核 |

---

## 7. 回滚方式

改动**尚未提交**，回滚成本极低：

```bash
# 丢弃全部已跟踪改动（4 个新增文件需一并手动删除）
git checkout -- .
git status --short            # 确认只剩未跟踪文件
```

若已提交，直接 `git revert <commit>` 即可（无迁移、无持久化 schema 变更，唯一副作用是
`verification/results/` 与 `verification/intelligence/` 的产物内容会随重建恢复旧口径）。

**注意**：回滚会把两个已修缺陷（`postureFresh` 计为进展、签核虚假绿色）以及页签守卫一并带回，
即回到本报告开头描述的"回退代价"状态。

---

## 8. 联系与依据

- 修改详情与全部实测数字：见 [修改报告](./changes-2026-10-05.md)
- 复现方法：把真实项目的 `docs/02_requirements/*.md` 复制到临时工作区，调用真实引擎
  `buildVerificationIntelligence`，比对 `requirement-model.json` 与 `scenario-registry.json`。
  本轮全部复现均在系统临时目录进行，**未读写任何真实项目目录**。
