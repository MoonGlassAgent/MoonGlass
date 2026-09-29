# 验证环境编码规范 (VECS)

Verification Environment Coding Standard

## 概述

本规范定义了基于 cocotb 验证环境的编码标准，确保生成代码的可维护性、可读性和一致性。
本文件作为 `cocotb-verification` skill 的编码参考，所有生成的验证代码必须遵循本规范。

> **Golden Model 接口标准**：统一使用 `reset()` + `process()` 方法，详见第 4 节。

---

## 1. 日志规范

> **cocotb 2.x**：`cocotb.log.SimLog` 已移除，日志对象统一通过标准库
> `logging.getLogger(f"cocotb.{name}")` 获取（文件顶部 `import logging`）。

### 1.1 日志级别

| 级别 | 使用场景 | 示例 |
|------|---------|------|
| **ERROR** | 测试失败、数据不匹配、超时 | `self.log.error(f"Data mismatch: actual=0x{actual:x}")` |
| **WARNING** | 非致命异常、可恢复错误 | `self.log.warning("Timeout waiting for response...")` |
| **INFO** | 关键节点、状态变化、配置信息 | `self.log.info(f"Configuring DUT: mode={mode}")` |
| **DEBUG** | 详细调试信息、循环内部数据 | `self.log.debug(f"Cycle {n}: state={state}")` |

### 1.2 日志格式

```python
# 统一格式：[ComponentName] 消息内容
self.log.info(f"[{self.name}] Configuration completed")
self.log.info(f"[{self.name}] State transition: {prev_state} -> {new_state}")
```

### 1.3 必打日志节点

**Driver 必须记录**：
- 配置参数（所有配置信号的值）
- 控制命令发送（start/stop/reset 等）
- 事务发送/接收

**Monitor 必须记录**：
- 启动/停止状态
- 状态机转换（如果有）
- 采样数据摘要（前 N 个 + 每 M 个）

**Scoreboard 必须记录**：
- 每次比对结果（PASS/FAILED）
- 失败时的详细对比（Actual vs Expected）
- 最终统计报告

**Environment 必须记录**：
- 复位完成
- 测试开始/结束
- 总体结果汇总

### 1.4 日志采样策略

为避免日志过多，采用分级采样：

```python
# 前 N 个详细打印，之后每 M 个打印
if count <= 5 or count % 50 == 0:
    self.log.info(f"[{self.name}] Sample #{count}: {data}")
```

### 1.5 测试分隔与结果输出

```python
import logging

# cocotb 2.x 已移除 SimLog，使用标准库 logging 获取日志对象
log = logging.getLogger("cocotb")

def log_test_start(test_name):
    log.info("=" * 80)
    log.info(f"TEST START: {test_name}")
    log.info("=" * 80)

def log_test_end(test_name, passed, details=None):
    log.info("=" * 80)
    status = "PASSED" if passed else "FAILED"
    log.info(f"TEST END: {test_name} - {status}")
    if details:
        for key, value in details.items():
            log.info(f"  {key}: {value}")
    log.info("=" * 80)
```

---

## 2. 数据格式规范

### 2.1 十六进制格式

```python
# 地址使用 0x{addr:010x} 格式（40 位地址）
self.log.info(f"Address: 0x{addr:010x}")

# 数据使用 0x{data:032x} 格式（128 位数据）
self.log.info(f"Data: 0x{data:032x}")

# 根据实际位宽调整格式宽度
# 8 位: 0x{val:02x}  16 位: 0x{val:04x}  32 位: 0x{val:08x}
```

---

## 3. 命名规范

### 3.1 组件命名

```python
# 使用统一的命名前缀，由 Environment 传入
self.name = name  # 如 "CounterEnv"
self.driver = Driver(dut, name + "_drv")
self.monitor = Monitor(dut, name + "_mon")
self.scoreboard = Scoreboard(self.golden_model, name + "_sb")
# 日志输出: [CounterEnv_drv] Sending transaction...
```

### 3.2 文件命名

```
transaction.py       # 事务定义
golden_model.py      # 参考模型
driver.py            # 驱动器
monitor.py           # 监控器
scoreboard.py        # 记分板
coverage.py          # 覆盖率
env.py               # 环境组装
test_<dut_name>.py   # 测试用例
Makefile             # 构建脚本
```

---

## 4. 组件接口标准

### 4.1 Transaction（事务）

```python
from dataclasses import dataclass

@dataclass
class MyTransaction:
    """事务类 - 必须使用 dataclass"""
    field1: int = 0
    field2: int = 0

    def __repr__(self):
        """必须实现 __repr__，便于日志输出"""
        return f"MyTransaction(field1=0x{self.field1:x}, field2=0x{self.field2:x})"
```

### 4.2 Golden Model（参考模型）

**统一接口：继承 `GoldenModelBase`，实现 `reset()` + `process()`**

```python
class MyGoldenModel(GoldenModelBase):
    """
    必须继承 GoldenModelBase
    核心方法：reset() 和 process()
    """

    def reset(self):
        """复位内部状态到初始值"""
        self.state = 0

    def process(self, transaction):
        """
        计算预期输出（核心方法）

        Args:
            transaction: 输入事务
        Returns:
            预期输出（格式必须与 DUT 输出一致）
        """
        expected = ...
        return expected
```

> **注意**：不要使用 `get_expected()` / `configure()` / `start()` 等非标准方法名。
> 如果需要配置，通过 `__init__` 参数或在 `process()` 内处理。

### 4.3 Driver（驱动器）

```python
class MyDriver:
    def __init__(self, dut, name="Driver"):
        self.dut = dut
        self.name = name
        self.log = logging.getLogger(f"cocotb.{name}")

    async def reset(self):
        """复位驱动器，清除所有控制信号"""
        # 必须打印复位完成日志
        self.log.info(f"[{self.name}] Reset complete")

    async def drive(self, transaction):
        """驱动事务到 DUT"""
        # 必须打印事务信息
        self.log.info(f"[{self.name}] Driving: {transaction}")
```

### 4.4 Monitor（监控器）

```python
class MyMonitor:
    def __init__(self, dut, name="Monitor"):
        self.dut = dut
        self.name = name
        self.log = logging.getLogger(f"cocotb.{name}")
        self.callbacks = []

    async def run(self):
        """持续监控 DUT 输出，采集事务"""
        # 使用采样策略控制日志量
```

### 4.5 Scoreboard（记分板）

```python
class MyScoreboard:
    def __init__(self, golden_model, name="Scoreboard"):
        self.golden_model = golden_model
        self.name = name
        self.log = logging.getLogger(f"cocotb.{name}")
        self.matched = 0
        self.mismatched = 0

    def check(self, transaction, actual_output):
        """
        比对实际输出与预期输出
        失败时必须打印 Actual vs Expected
        """
        expected = self.golden_model.predict(transaction)
        if actual_output != expected:
            self.mismatched += 1
            self.log.error(f"[{self.name}] MISMATCH:")
            self.log.error(f"  Actual:   {actual_output}")
            self.log.error(f"  Expected: {expected}")
        else:
            self.matched += 1

    def report(self):
        """打印最终统计（必须在测试结束时调用）"""
        total = self.matched + self.mismatched
        self.log.info(f"[{self.name}] Total: {total}, Passed: {self.matched}, Failed: {self.mismatched}")
        return self.mismatched == 0
```

### 4.6 Environment（环境）

```python
class MyEnvironment:
    def __init__(self, dut, name="Env"):
        self.dut = dut
        self.name = name
        self.log = logging.getLogger(f"cocotb.{name}")

        # 创建组件
        self.golden_model = MyGoldenModel()
        self.driver = MyDriver(dut, name + "_drv")
        self.monitor = MyMonitor(dut, name + "_mon")
        self.scoreboard = MyScoreboard(self.golden_model, name + "_sb")

    async def reset(self, duration_ns=100):
        """标准复位流程"""
        self.log.info(f"[{self.name}] Resetting DUT...")
        self.dut.rst_n.value = 0
        await RisingEdge(self.dut.clk)
        # 清除所有输入信号为默认值
        await Timer(duration_ns, unit='ns')
        await RisingEdge(self.dut.clk)
        self.dut.rst_n.value = 1
        await RisingEdge(self.dut.clk)
        self.golden_model.reset()
        self.log.info(f"[{self.name}] Reset complete")

    def report(self):
        """汇总报告"""
        return self.scoreboard.report()
```

---

## 5. 测试用例标准

```python
@cocotb.test(timeout_time=5000, timeout_unit='us')
async def test_feature_x(dut):
    """
    测试用例文档字符串（必须包含）
    - 测试目标：xxx
    - 预期结果：xxx
    """
    test_name = "Feature X Test"
    log_test_start(test_name)

    # 1. 启动时钟（必须）
    clock = Clock(dut.clk, 10, unit='ns')
    cocotb.start_soon(clock.start())

    # 2. 创建环境（必须）
    env = MyEnvironment(dut)

    # 3. 复位（必须）
    await env.reset()

    # 4. 执行测试
    # ... 测试逻辑 ...

    # 5. 验证结果（必须有 assert）
    passed = env.report()

    # 6. 结构化结果输出（必须）
    log_test_end(test_name, passed)
    assert passed, f"{test_name} FAILED"
```

---

## 6. 代码质量检查清单

验证环境完成后，对照检查：

- [ ] **事务层**：所有数据结构已定义，包含 `__repr__` 方法
- [ ] **Golden Model**：继承 `GoldenModelBase`，实现 `reset()` + `process()`
- [ ] **Driver**：配置参数和控制命令都有日志
- [ ] **Monitor**：采样频率合理（前 N 个详细 + 每 M 个采样）
- [ ] **Scoreboard**：失败时打印 Actual vs Expected
- [ ] **Environment**：提供 `reset()` 和 `report()` 标准接口
- [ ] **测试用例**：包含文档字符串、`log_test_start/end`、assert
- [ ] **日志**：所有组件使用 `[ComponentName]` 前缀
- [ ] **Makefile**：可直接运行，包含 `cocotb-config`

---

**核心理念：日志即文档。** 详细的日志不仅帮助调试，也是验证计划的可执行体现。
