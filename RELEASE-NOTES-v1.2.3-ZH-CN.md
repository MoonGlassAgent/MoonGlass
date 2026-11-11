# MoonGlass v1.2.3 发布说明

MoonGlass v1.2.3 继续完善长程验证链路的可靠性：升级 Agent 运行时，并把"工程师具名裁决"的终局语义补齐为持久化语义。

## 主要更新

### 运行时升级：pi-coding-agent 1.3.0 → 1.5.2

- 上游修复一批实用问题：输出截断后的工具调用恢复、Windows shell 检测、Markdown 在 CJK 标点处的渲染、grep 配置忽略等。
- 新增 GPT-6.1 Terra 模型支持。
- 工具参数校验从 TypeBox 迁移到 pi-schema：MoonGlass 的工具声明全部使用纯 JSON Schema，实测不受该变更影响（Type.Refine/BigInt/Format.Set 等扩展不在使用范围）。

### 裁决持久化（承接另一团队在途 TDD）

- `WAIVED`（豁免）与 `BLOCKED_BY_SPEC`（规格阻断）被定义为**具名终局裁决**：后续即使产生更新的 FAIL hit，也不得回写为 FAILED。
- hit 仅作为执行事实透传（evidence/failureSummary 照常保留），不推翻裁决。
- 其余状态维持既有口径：裁决晚于证据则裁决生效，否则证据优先；无判断类裁决的 FAILED 场景照常 FAILED，不误伤。
- 配套 `fix-dispatch-filter-smoke`（D1–D6 持久化 + G1–G3 修复派单过滤）全部通过。

### 与近期版本的关系

- v1.2.2 的过程/性能义务通道分类（面积/时序义务归 SYNTH 通道、不再误弹 VERIF 决策）与决策语言人性化（humanSummary、决策卡新布局、按钮语义透明化）在本版中全部保留。
- pi 1.3.0 引入的 codemode 提示词降耗（约 -40%）与 OpenRouter 按 key 拉取模型清单能力继续生效。

## Windows 绿色版

- ZIP：`MoonGlass-1.2.3-Windows-x64-Green-v1.2.3-20261111.zip`
- 大小：约 357.7 MB
- 展开文件数：526
- SHA-256：`1E8A1AA3EF0105570F0F1DC4CD3AF779FECC28157C2A6D159C9E4793854F5043`
- 内置 pi-coding-agent 1.5.2 与 MoonGlass AIGV 工具链；演示项目为 MIC_NPU。

## 下载

- GitHub Release：`https://github.com/MoonGlassAgent/MoonGlass/releases/download/v1.2.3/MoonGlass-1.2.3-Windows-x64-Green-v1.2.3-20261111.zip`
