# Formal 工具回归说明：MoonGlass 0.9.8 中文路径下 sby 调用失败（提交开发团队）

| 项目 | 内容 |
|---|---|
| 文档编号 | BUG-FORMAL-PATH-001 |
| 日期 | 2026-09-28 |
| 报告人 | 验证（VERIF 阶段，W3 签核） |
| 项目 | DDR_BIST |
| 严重程度 | **高**（Formal 验证整体不可用） |
| 状态 | 待开发团队确认 |

---

## 1. 问题现象

**MoonGlass 0.9.8 环境下，`run_formal_verification` 100% 失败。**

`run_formal_verification` 返回：

```text
状态：ERROR
分类：求解结果
说明：Formal 任务状态 ERROR，请检查日志
```

日志内容：

```text
Traceback (most recent call last):
  File "D:\tools\MoonGlass-0.9.8\...\aigv-toolchain\bin\sby-script.py", line 329, in <module>
    with (open(sbyfile, "r") if sbyfile is not None else sys.stdin) as f:
FileNotFoundError: [Errno 2] No such file or directory:
  'D:\\\udccf\udcee\u013f\udcd0\udcc5\u03e2\\\u05aa\u02b6\udcbf\udce2\\DDR_BIST\\verification\\formal\\traffic_controller_bmc200_a3fix_r2.sby'
```

**关键观察**：报错路径中的 `\udccf\udcee\u013f\udcd0\udcc5\u03e2\...`
是本项目真实路径 `D:\项目信息\知识库\DDR_BIST\` 的**错误解码结果**
（中文被按 latin-1/GBK 误解为孤立代理项）。

---

## 2. 根因定位

### 2.1 证据链

| 证据 | 内容 |
|---|---|
| ① 文件确实存在 | `verification/formal/traffic_controller_bmc200_a3fix_r2.sby` 在磁盘上存在 |
| ② 非深度问题 | 用深度 **40**（历史成功过的深度）重跑，同样 ERROR |
| ③ 非文件列表问题 | 传入全 10 个 RTL 文件（与历史 PASS 案例一致），同样 ERROR |
| ④ 非脚本问题 | 0.9.5 与 0.9.8 的 `sby-script.py` **完全相同**（同为 Jul 21，19855 字节） |
| ⑤ **版本对比** | 09-14 成功案例日志显示用 **MoonGlass-0.9.5**；当前为 **0.9.8** |
| ⑥ 0.9.8 下无成功案例 | 本日 3 次 Formal 尝试全部 ERROR |
| ⑦ 安装时间 | `MoonGlass-0.9.8` 目录时间戳 **2026-09-28 10:26**（今日升级） |

### 2.2 结论

**MoonGlass 0.9.8 引入回归：调用 sby 时传给 `sby-script.py` 的 `.sby` 文件路径
未正确编码，导致含非 ASCII（中文）字符的项目路径被破坏，sby 无法打开配置文件。**

| 环境 | 结果 |
|---|---|
| MoonGlass-0.9.5（09-14 及之前） | ✅ Formal 正常（PASS / UNKNOWN 等） |
| MoonGlass-0.9.8（09-28 今日升级后） | ❌ 100% ERROR |

### 2.3 附加异常：配置文件未生成

正常成功的任务目录包含工具生成的配置与中间产物：

```text
results/traffic_controller_bmc128_a3fix/
  PASS
  config.sby          <-- 工具在工作目录内生成的配置
  engine_0
  logfile.txt
  model
  src
  status
  status.sqlite
  traffic_controller_bmc128_a3fix.xml
```

本次失败的任务目录**仅有 2 个文件**：

```text
results/traffic_controller_bmc200_c6retry/
  formal-result.json
  moonglass-formal.log     <-- 无 config.sby / engine_0 / model / src
```

**说明工具在中文路径下未能写入 `config.sby`**，随后回退去读项目根下的 `.sby`，
又因路径编码问题失败。

---

## 3. 复现步骤

```bash
# 前置：项目路径含中文（D:\项目信息\知识库\DDR_BIST）
# 环境：MoonGlass 0.9.8

# 调用（任一 Formal 任务均可复现）
run_formal_verification(
    top="traffic_controller_formal",
    rtlFiles=[...],                       # 全 10 个 RTL 文件
    propertyFiles=["verification/formal/traffic_controller_formal.sv"],
    mode="bmc", depth=200, engine="boolector",
    taskName="traffic_controller_bmc200_c6retry"
)

# 结果：ERROR
# 日志：verification/formal/results/traffic_controller_bmc200_c6retry/moonglass-formal.log
# 观察：目录内缺 config.sby
```

**最小复现**：任何 `taskName` + 任何 `depth` 均可复现（已验证 200 与 40）。

---

## 4. 对照实验

| 实验 | 变量 | 结果 |
|---|---|---|
| 深度 200，仅 `traffic_controller.v` | 文件列表 | ERROR |
| 深度 200，全 10 个 RTL 文件 | 文件列表 | ERROR |
| 深度 **40**，全 10 个 RTL 文件 | 深度（历史 PASS 值） | **ERROR** |

三组均失败，且失败点相同（`sby-script.py` 第 329 行 `open(sbyfile)`），
排除深度、文件列表、harness 内容等变量。

---

## 5. 影响评估

### 5.1 对 DDR_BIST 项目的影响

| 影响项 | 说明 |
|---|---|
| Formal 验证 | 当前**完全无法执行** |
| W3 签核 | C6 项（2 个历史 ERROR 任务）**无法通过重跑关闭** |
| `formal-candidate` 场景 | 17 个场景应由 Formal 关闭，现无法推进 |
| 已有 Formal 证据 | 09-14 及之前的 PASS 结果**仍然有效**（`rtlHash` 一致），不受影响 |

### 5.2 未受影响的部分

- 仿真回归：113/113 通过
- 覆盖率：行 92.44% / 条件 87.41% / 功能 98.97%
- Mutation：13/13 KILLED
- Lint：0 Error

**即仿真路径完全正常，仅 Formal 路径受阻。**

---

## 6. 请求开发团队确认/解决

### 6.1 功能修复（核心）

**请求 F1**：修复 0.9.8 中传给 `sby-script.py` 的路径编码问题，
确保含非 ASCII 字符的项目路径可正常打开 `.sby`。

**请求 F2**：修复前请确认失败时**是否已在 `results/<task>/` 下写出 `config.sby`**。
本次观察到该文件缺失，若属工具逻辑缺陷（例如写文件前即因编码异常退出），
建议一并修正。

### 6.2 咨询

**问题 Q1**：0.9.8 是否更改了子进程调用的工作目录或路径传递方式？
（0.9.5→0.9.8 的 `sby-script.py` 字节完全相同，故问题应在**调用方**。）

**问题 Q2**：是否有受支持的方式让验证侧规避该问题？
例如：通过环境变量指定 ASCII 临时工作目录、
或将项目迁移至纯 ASCII 路径运行 Formal。

**问题 Q3**：已知的成功案例（09-10 / 09-14，使用 0.9.5）证据是否仍被 0.9.8 采信？
本项目中 `rtlHash` 一致，故验证侧判定其有效；请确认工具侧口径。

---

## 7. 验证侧当前处置

在工具修复前，验证侧采取以下措施：

1. **保留** 09-14 及之前的 Formal 证据（`rtlHash` 一致，判定有效）
2. **在 W3 签核文档中明确标注**：C6 的 2 个 ERROR 任务
   系**工具路径回归**导致，**不得解释为 RTL 缺陷或属性不可达**
3. **清理**本次诊断产生的 3 个探针任务目录，避免污染证据区
4. **暂不重跑** Formal，待工具修复后统一执行

---

## 8. 相关产物

- W3 覆盖率闭合与 C1–C6 分类：`docs/04_verification/w3_coverage_closure.md` §3（C6）
- 本问题单：`docs/04_verification/formal_tool_path_regression.md`

---

## 9. 备注

本文档仅描述现象与定位过程，不预设工具代码缺陷的具体位置。
证据 ①~⑦ 均可复现，若开发团队需要进一步日志或环境信息，验证侧可配合提供。
