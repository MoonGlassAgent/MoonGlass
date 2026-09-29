# MoonGlass 验证环境零摩擦 —— 实施指导文档（移交实施团队）

> 状态：实施中 · 环境专项团队回执见文末 §6（2026-09-29）
> 日期：2026-09-29
> 关联版本：MoonGlass v0.9.10
> 目标读者：承接"EDA/仿真环境"专项的实施团队。**不要求**读者了解 AIGV 引擎与 Agent 编排；
> 本指南的每个任务都给出了问题、证据出处、涉及文件（含行号）、建议修法与验收标准。
> 总目标：**新用户从安装 MoonGlass 到跑通第一个 cocotb 仿真，全程零手动排障**；
> 已知 15 项环境坑逐项清零或显式拦截。

---

## 0. 必须遵守的仓库约束

1. 工程规范见仓库根 `AGENTS.md`：TypeScript strict、ESM、注释中文、UI 文案走 i18n
   （`src/renderer/i18n/`，zh-CN 为源语言，禁止组件内硬编码界面文案）。
2. 每次改动后 `pnpm typecheck` 必须全过；根应用有 **11 个历史基线错误**，不得新增。
3. `packages/verification-intelligence-engine` **不得引入新外部依赖**（其源码会被复制到
   pi 子进程侧运行）；`packages/eda-bridge` 同样以源码形式被 pi-bridge 内联使用，加依赖前
   先确认打包链路（`resources/moonglass/pi-bridge/` 的复制逻辑）。
4. 内置 EDA 运行时由 `scripts/stage-aigv-runtime.mjs` 从本机 OSS CAD Suite 裁剪打包，
   产物为 `resources/moonglass/bundled-toolchains/windows-x64/moonglass-aigv-runtime.tgz`；
   改打包内容必须同步改 manifest 并全量重跑打包 + 解压自检（`EdaService.ensureBundledAigvRuntime`）。
5. 绿色版 portable-mode：可执行文件旁有 `portable-mode` 标记时 userData 重定向到 exe 旁
   `userdata/`；任何写死 userData 路径的改动都会破坏绿色版。
6. 当前仅支持 Windows x64；所有 shell 交互注意 Git Bash/MSYS 与 cmd 的差异，
   解压统一用系统 bsdtar（GNU tar 会把 `D:` 盘符当远程主机，`EdaService.ts:19-24`）。

---

## 1. 环境体系现状速览（实施前必读）

- **三层工具供给**：
  - bundled：随包内置 AIGV 运行时（slang/yosys/yosys-abc/sby/yosys-smtbmc/boolector/bitwuzla
    + 内置 Python 3.11），由 `EdaService.ensureBundledAigvRuntime()`（`src/main/services/EdaService.ts:461-472`）
    解压到 userData，`activateToolchains()`（`:474-498`）把 bin/lib 前置进 PATH。
  - managed：一键安装（OSS CAD Suite、Verible、Python+cocotb），入口
    `EdaService.startInstallMissing()`（`:173`），计划在 `packages/eda-bridge/src/install-plan.ts`。
  - system：用户自装（Python、Git、GTKWave 等）。
- **仿真链路**：cocotb（icarus 默认，需覆盖率时升级 verilator）与 Verilator C++ TB 两条路径，
  实现于 `packages/eda-bridge/src/simulation.ts`；**cocotb 全链路使用系统 Python**。
- **探测**：`packages/eda-bridge/src/detect.ts` 探测 20 项工具，真实执行 version 命令
  （非零退出判缺失），但**无任何版本范围校验**；结果缓存 `eda-detection-cache.json`。
- **唯一安装后真自检**：cocotb 装后 `import cocotb` 回显版本（`EdaService.ts:363-364`）；
  运行期唯一工具自检是 `checkIcarusToolchain()`（`simulation.ts:359-388`，iverilog/vvp
  真实编译运行最小程序）——这是"安装后自检"的现成参考实现。

---

## 2. 任务分解

### T1（P0）cocotb 版本治理：消除"四错位"

**问题**：当前是"运行侧要求 2.x、安装侧无 pin、技能模板 1.x、校验器无版本检查"的四错位——
- 运行侧：`runCocotbSimulation` 生成的 runner 用 `from cocotb_tools.runner import get_runner`
  （`simulation.ts:454`，cocotb 2.0 新增包），Windows+verilator 后端还猴子补丁了
  cocotb 私有 API `runner._build_command`（`:462-468`），对版本敏感。
- 安装侧：`pip install --user --upgrade cocotb cocotb-bus cocotb-coverage`
  （`EdaService.ts:362`），装的是 PyPI 最新（用户实测 2.0.1）。
- 技能模板（Agent 生成验证环境的蓝本）仍是 1.x 写法：
  `resources/moonglass/skills/cocotb-verification/assets/test.py:12` 用已删除的
  `cocotb.result.TestSuccess`；大量 `Timer/Clock(..., units=...)`（2.0 改为 `unit=`）；
  driver/monitor/env/scoreboard 全部 `from cocotb.log import SimLog`（2.0.1 下
  `ModuleNotFoundError`，e2e 实测见 `e2e-screenshots/managed-verif-timeline-1790600085988.md:36`）。
- 校验器：`resources/moonglass/skills/cocotb-verification/scripts/validate_env.py`
  无 cocotb 版本检查，还把 `TestSuccess` 当正面证据（`:214`）。
- 探测侧：`detect.ts:36` 只回显版本，装 1.x 也判"已就绪"。

**建议修法**：
1. 选定一个已验证的 cocotb 版本精确 pin（建议在当前实测过的 2.0.1 或更新的 2.x 中选，
   跑通 §4 全部仿真 smoke 后锁定）：安装命令改为 `pip install --user --upgrade "cocotb==X.Y.Z" ...`，
   pin 值集中到 `resources/moonglass/toolchains.json` 或 eda-bridge 常量，单一出处。
2. `detect.ts` 的 cocotb 探测加版本范围校验（低于 pin 主版本判"版本不兼容"并给出升级指引）。
3. 技能模板全部升级为 2.x 写法：`cocotb.log`→标准 `logging`、删除 `TestSuccess/TestFailure`
   用法（改 `assert`/自然返回）、`units=`→`unit=`；同步更新 `references/cocotb_basics.md`、
   `references/cocotb_examples.md` 的教学代码；`gen_cocotb_env.py` 生成的 README 写明 pin 版本。
4. `validate_env.py` 增加：cocotb 版本检查 + 已知 2.0 不兼容导入扫描（`cocotb.result`、
   `cocotb.log`、`units=` 关键字）。
5. 仓库内嵌 smoke 已是 2.x 写法（`scripts/verilator-coverage-smoke.mjs:42`），作为对照基准。

**验收**：全新环境 pin 版本下 `verilator-coverage-smoke`、`waveform-guard-smoke` 全绿；
用 `gen_cocotb_env.py` 生成的环境不经手改即可编译运行；`validate_env.py` 对 1.x 写法
给出明确报错而非通过。

### T2（P0）C++ TB 端口名解析 bug

**问题**：`generate_tb` 的端口正则把 `input wire en` 解析成名为 `wire` 的端口，
TB 驱动不存在的 `top->wire`（`resources/moonglass/pi-bridge/moonglass-tools.ts:462`，
e2e 实测见 `reports/managed-verif-e2e-20260928.md:48`）。**至今未修。**

**建议修法**：`PORT_DIR` 正则匹配方向后跳过 `wire/reg/logic` 等声明关键字；
顺手核对 `input wire signed [3:0]` 等组合。补最小用例进 `waveform-guard-smoke`
或 `pi-tools-smoke`（RTL 含 `input wire en`，断言 TB 端口提取为 `en`）。

**验收**：新增 smoke 绿；既有 TB 生成 smoke 不回归。

### T3（P0）安装版本钉死 + 安装后真自检

**问题**：三类一键安装全部拉 latest 无 pin（OSS CAD Suite `EdaService.ts:253`、
Verible `:297`、cocotb 见 T1）；OSS CAD Suite/Verible 装完只查目录存在，不跑任何工具。

**建议修法**：
1. pin 到具体 release tag（集中到 toolchains.json/常量，含预期资产名），升级走
   "改 pin + 重跑 §4 验收"的显式流程；下载 URL 模板相应从 `latest` 改为 `download/<tag>/`。
2. 安装后自检（每个 bundle 装完立即跑，失败明示并给出重试/手动指引）：
   - OSS CAD Suite：跑 `yosys -V`、`iverilog -V`，并做 iverilog 编译运行最小冒烟
     （复用 `checkIcarusToolchain()` 的最小程序，抽出为可复用函数）；
   - Verible：跑 `verible-verilog-lint --version` + 对一个内联最小 SV 文件 lint；
   - cocotb：T1 的版本回显保留，升级为版本范围校验。
3. 自检结果写入安装结果消息（i18n 文案），失败不等于"安装成功"。

**验收**：人为制造坏包（删 bin 内关键 exe）后自检必失败且消息指名缺失项；
正常路径 `eda-install-plan-smoke`（按需扩展）与真实安装流程通过。

### T4（P1）cocotb 供给链：bundled 化（决策项）

**问题**：cocotb 全链路依赖用户系统 Python（`simulation.ts:425`、`detect.ts:36`、
`EdaService.ts:358`）；内置 Python 3.11 无 pip 无预装能力（`stage-aigv-runtime.mjs:28-33`
裁剪掉了 ensurepip/site-packages，仅供 sby wrapper）。系统 Python 版本/编码/权限
（`pip --user`）都是摩擦源。

**两个方案**：
- A（推荐）：bundled Python 恢复 ensurepip+pip，打包期预装 pin 版本的
  cocotb/cocotb-bus/cocotb-coverage；仿真链路改用 `CocotbSimOptions.pythonExecutable`
  指向内置解释器（参数已存在，`simulation.ts:172`）。彻底消除系统 Python 依赖，
  代价是包体增大与打包流程变重（需验证 verilator 后端对内置 Python 的兼容性、
  猴子补丁 `runner._build_command` 在 pin 版本下的稳定性）。
- B（保底）：维持系统 Python，T1 pin + T3 自检 + 探测期 Python 版本/UTF-8 模式检查
  （`python -X utf8`，case2 用户正是靠它绕开 GBK 问题）。

**验收**：方案 A 需全量仿真 smoke 在内置 Python 下通过 + 绿色版实测；方案 B 需探测页
对不合规系统 Python 给出明确指引。**请产品侧拍板后实施。**

### T5（P1）中文/非 ASCII 路径收尾

**已修（机制：非 ASCII 只经 cwd 宽字符传递，argv/文件内容一律相对纯 ASCII）**：
sby（`formal.ts:80-117` + 中文路径回归 smoke）、Verilator C++ TB（`simulation.ts:671-706`）、
Yosys 综合（`synthesis.ts:336-340,374-378`）。

**收尾任务**：
1. SYNTH-D2 未证实假设闭环：case2 报告"Yosys ALUMACC 阶段无错误中断与路径编码同源"
   至今未证实（`用户问题收集/case2/moonglass_defect_submission_pack.md:134`、
   `交流/交流_20260911.txt:68-69`）。做 ASCII 路径对照实验判定真伪，结论回填文档。
2. iverilog/cocotb 路径无非 ASCII 前置检查——对齐 formal.ts:85-87 的做法：
   进入仿真前检查 RTL/TB 相对路径含非 ASCII 时给出明确提示（cocotb 实测在中文路径
   工作区可跑，但 TB 内写死绝对路径的场景仍会炸，检查 TB 文本内的非 ASCII 绝对路径引用）。
3. Formal 仍硬拒非 ASCII 文件名——在 UI/文档明示该限制（设置页或错误消息已部分覆盖，
   补 `docs/USER-MANUAL-ZH-CN.md` 说明）。

**验收**：中文路径工作区全链路（lint→仿真→覆盖率→Formal→综合）实测记录表；
SYNTH-D2 结论落文档。

**回填（2026-09-29 环境专项团队）**：
1. SYNTH-D2 **已闭环，证伪**。五组对照实验（本机代码页 936/GBK + OSS CAD Suite yosys 0.67+84）：
   中文路径 cwd + 相对路径综合 PASS 且 logfile hash 与纯 ASCII 基线逐字节一致；UTF-8 中文绝对路径
   写进 .ys 脚本产生的是**显式 File-not-found 错误**（fail-loud），并非无声中断；临时移除
   yosys-abc.exe 精确复现了 case2 记录的现象——日志停在 ALUMACC 之后的 ABC 阶段、cmd 的 GBK 错误
   消息混入日志呈乱码。**结论：SYNTH-D2 与 SYNTH-D1（yosys-abc 漏打包）是同一缺陷，与路径编码无关。**
   完整记录：`用户问题收集/case2/synth-d2-experiment-20260929.md`（原始日志 `out/synth-d2-exp/`）。
2. iverilog/cocotb 非 ASCII 前置检查已实施（`simulation.ts`：TB 内非 ASCII 绝对路径引用→抛错指明
   文件与行号；RTL/TB 路径含非 ASCII→编译日志写 `[note]` 提示不阻断）。
3. USER-MANUAL-ZH-CN.md 已补"工具链与非 ASCII 路径说明"章节（Formal 硬拒限制、cocotb TB 绝对路径
   拦截、版本钉死说明）。
4. 中文路径工作区**全链路**（lint→仿真→覆盖率→Formal→综合）在干净中文用户名机器上的实测
   留待 §4 DoD 验收执行（本机用户名为 ASCII；综合链路已在 GBK 环境实测通过）。

### T6（P1）用户侧环境自检（env doctor）

**问题**：现有 smoke 全是开发侧资产（相对路径 import 仓库源码，依赖仓库 node_modules），
不能在只有 userData 的用户环境跑；用户侧没有任何"一键体检"。

**建议修法**：设置页 EDA 工具链区加"环境自检"按钮，走新 IPC 在主进程执行最小端到端检查
（不依赖仓库源码，全部内联实现）：
1. iverilog 编译+运行最小程序（复用 T3 抽出的函数）；
2. verible lint 最小 SV；
3. yosys 综合最小模块（含 ABC，覆盖 yosys-abc 漏打包类问题）；
4. sby bmc 最小 property（覆盖 sby/perl/编码路径）；
5. cocotb+icarus 跑一个 1 断言测试（覆盖 runner 生成、pin 版本、JUnit 产出）。
逐项显示 PASS/FAIL + 失败时的修复指引（指到对应安装按钮）。注意走
`EdaService.activateToolchains()` 注入的 PATH 与 `tool-runner.ts` 的 MinGW DLL 隔离。

**验收**：在干净 Windows 机器（仅装 MoonGlass）上一键自检全 PASS；
人为卸载某工具后对应项 FAIL 且指引正确。

### T7（P2）Agent shell 工作区围栏（尽力版，决策项）

**问题**：e2e 观察到 Agent shell `cd` 出工作区写文件（`reports/managed-verif-e2e-20260928.md:47`）；
目前只有 RTL 修复窗口内对 rtl/ 的尽力拦截（`rtl-write-guard.ts`，明确声明非硬保证）。

**建议修法（若拍板做）**：在 pi-bridge 的 tool_call 钩子里对 bash 命令做工作区外写入的
启发式拦截/告警（与 rtl-write-guard 同一"尽力拦截 + 落盘审计"哲学），拦截记录落盘供审计。
**注意**：误拦会打断正常流程，需充分灰度；此项涉及 Agent 行为，建议与主团队联审。

---

## 3. 已知环境坑总表（15 项，对账用）

| # | 坑 | 状态 | 出处 |
|---|---|---|---|
| 1 | cocotb 2.0.1 API 变动（cocotb.log/TestSuccess/units） | **已修**（T1：pin 2.0.1 + 模板全量升 2.x + detect/validate_env 版本与习语检查） | managed-verif-e2e 报告:48 |
| 2 | oss-cad-suite verilator perl wrapper 缺 Pod::Usage | 已绕过（走 verilator_bin.exe，`tool-runner.ts:20-23`）；自检覆盖 → T6（已交付） | 同上 |
| 3 | generate_tb 端口名 `input wire en`→`wire` | **已修**（T2：PORT_DIR 跳过 wire/reg/logic/signed 等关键字；`scripts/tb-port-parse-smoke.mjs` 22 断言回归） | 同上 |
| 4 | 中文路径 sby argv GBK（BUG-FORMAL-PATH-001） | 已修（formal.ts:80-117 + smoke） | case3 |
| 5 | 非 ASCII 路径 Verilator .mk GBK | 已修（simulation.ts:671-706） | case2 #6 |
| 6 | Yosys ALUMACC 无错中断（SYNTH-D2 假设） | **已闭环**（T5.1 对照实验证伪"路径编码同源"，真凶为 SYNTH-D1 yosys-abc 缺失；见 `用户问题收集/case2/synth-d2-experiment-20260929.md`） | case2:134 |
| 7 | yosys-abc.exe 漏打包 | 已修（stage-aigv-runtime.mjs:15-17） | case2 / SYNTH-D1 |
| 8 | 系统 MinGW DLL（Strawberry Perl 等）抢占 | 已隔离（tool-runner.ts:37-68） | tool-runner.ts:105-108 |
| 9 | GNU tar 把 D: 当远程主机 | 已修（统一 bsdtar） | EdaService.ts:19-24 |
| 10 | yosys-smtbmc.exe.exe 命名异常 | 已修（隔离 shim） | CHANGELOG-DEV.md:430 |
| 11 | Agent shell 逃逸工作区 | **未修** → T7（决策项） | managed-verif-e2e 报告:47 |
| 12 | cocotb+icarus 0 字节编译日志/退出码矛盾 | 已修（simulation.ts:521-544） | case2 #10 |
| 13 | 外部安装器改 PATH 对运行中进程不可见 | 已修（注册表合并，EdaService.ts:99-117） | — |
| 14 | VERILATOR_ROOT 反斜杠被 make 吞 | 已修（tool-runner.ts:116-119） | — |
| 15 | cocotb 2.x JUnit testcase name 兼容 | 已修（simulation.ts:552-556 + 多层兜底） | 交流_20260908.txt:478-480 |

## 4. 总体验收（DoD）

1. 干净 Windows 10/11 机器（无 Python、无 EDA 工具、中文用户名）安装 MoonGlass 绿色版，
   一键安装缺失工具后环境自检（T6）全 PASS。
2. 新建示例项目走完 RTL→VERIF，cocotb 环境由技能模板生成后不经手改即可跑通，
   仿真产物（日志/JUnit/result.json/波形）齐全。
3. §3 表中"未修/未闭环"项清零；`pnpm typecheck` 全过（不新增于基线 11 个之外）；
   core + integration smoke 套件全绿。
4. 中文路径工作区全链路实测记录回填本文档 §T5。

## 5. 与主团队的接口

- **探测契约**：`ToolDetection` 新增字段（如版本兼容标记）需同步
  `src/shared/types/moonglass.ts` 与设置页展示。
- **toolchains.json**：pin 值集中后，主团队升级工具链只改一处。
- **联审点**：T4（供给链方案）、T7（Agent 行为）实施前需主团队参与评审；
  其余任务可独立推进，PR 评审按仓库常规流程。
- **测试资产**：`scripts/run-tests.mjs`（core 24 + integration 6）是回归基线；
  新 smoke 随任务交付并登记进套件。

---

## 6. 实施回执（环境专项团队，2026-09-29）

> 回归基线：`pnpm typecheck:root` 维持既有 11 个历史错误、零新增；`pnpm typecheck`（5 个
> workspace 包）全绿；core **28** + integration **7** 套件全绿（较移交时 +4：toolchain-manifest、
> tb-port-parse 进 core；env-self-check 进 integration）。

| 任务 | 状态 | 交付物 | 验证 | 遗留 |
|---|---|---|---|---|
| T1 | **已实施** | `packages/eda-bridge/src/toolchain-manifest.ts`（pin 单一出处，`cocotb==2.0.1`，范围 >=2.0.0 <3.0.0）；`detect.ts` cocotb 版本范围校验（`ToolDetection.versionCompatible`/`versionHint`，探测缓存 v2→v3）；技能模板 19 个文件升 2.x（SimLog→logging、TestSuccess/TestFailure→assert/return、`units=`→`unit=`）；`validate_env.py` 新增 compat 检查族（版本检查 + 1.x 习语扫描，TestSuccess 不再当正面证据）；`gen_cocotb_env.py` README 写明 pin；设置页"版本不兼容"徽标 | grep 零残留；py_compile 全过；模板 import 冒烟（本机 cocotb 2.0.1）；validate_env 对 1.x 环境 3 error/exit 1、对 gen 生成的 2.x 环境 0 error；core+integration 全绿（含 cocotb 2.0.1 真实仿真链路） | `verilator-coverage-smoke` 的 Windows+verilator 猴子补丁（`simulation.ts:462-468`）已随 pin 2.0.1 验证；未来升级 pin 需重验 |
| T2 | **已实施** | `moonglass-tools.ts:462` PORT_DIR 正则跳过 wire/reg/logic/bit/tri/signed/unsigned；`scripts/tb-port-parse-smoke.mjs`（22 断言，登记 core） | smoke 全绿；`waveform-guard-smoke`（真实 Verilator+cocotb）不回归 | 多行续写端口声明为已知遗留边界（行 trim 后关键字跳过不生效） |
| T3 | **已实施** | OSS CAD Suite pin `2026-09-28`（sha256 `71a0a165…`）、Verible pin `v0.0-4296-g0f262651`（sha256 `4590841d…`），URL 改 `releases/download/<tag>/` 直链，下载后 sha256 校验（不匹配即失败不解压）；装后真自检：OSS（`yosys -V`+`iverilog -V`+`verifyIcarusToolchain` 最小编译运行）、Verible（`--version`+最小 SV lint）、cocotb（版本范围校验）；自检失败判安装失败并指名缺失项 | `toolchain-manifest-smoke`（pin 形状/版本范围五组断言）绿；`eda-install-plan-smoke` 不回归 | 未真实下载 600MB 包做端到端安装验证；坏包负向验收（删 exe 必失败）未实机执行 |
| T4 | **未实施**（决策项） | — | — | 等产品侧拍板方案 A（bundled Python）/B（系统 Python + 探测检查）；`CocotbSimOptions.pythonExecutable` 挂点已就绪 |
| T5 | **已实施/已闭环** | SYNTH-D2 实验记录 `用户问题收集/case2/synth-d2-experiment-20260929.md`；`simulation.ts` cocotb 非 ASCII 前置检查；USER-MANUAL 非 ASCII 说明章节 | 见 §T5 回填；中文路径综合实测 PASS（hash 与 ASCII 基线一致） | 干净中文用户名机器全链路实测留待 DoD |
| T6 | **已实施** | `eda:self-check` IPC（shared 契约→preload→ipc.ts→`EdaService.runEnvironmentSelfCheck()`）；5 项检查（icarus 编译运行 / verible lint / yosys+ABC 综合 / sby bmc / cocotb+icarus 1 断言），工作目录 `<userData>/moonglass/self-check/`（纯 ASCII 文件名 + cwd 相对传参）；设置页"环境自检"按钮 + 逐项 PASS/FAIL/跳过 + 失败项"前往安装"；i18n zh-CN/en | `env-self-check-smoke` 本机实测：4 PASS + verible 正确 SKIP（未装）；登记 integration | 干净 Windows 机器（中文用户名）端到端验收未执行（本机 ASCII 用户名）；UI 未做 Electron 截图验证 |
| T7 | **未实施**（决策项） | — | — | 需与主团队联审 Agent 行为 |

### DoD 对照

1. 干净 Windows 机器（无 Python、中文用户名）绿色版一键安装 + 自检全 PASS —— **未执行**，需目标环境；
   各单项已在本机（GBK 936 + 真实工具链）验证。
2. 技能模板生成的 cocotb 环境不经手改即可跑 —— 模板侧已验证（import 冒烟 + validate_env 0 error）；
   App 内 RTL→VERIF 全流程 e2e 未重跑。
3. §3 未修/未闭环项：#1、#3、#6 已清零；#11（T7）维持未修待决策。typecheck 无新增；套件全绿。
