# Cocotb 基础教程

## 简介

Cocotb (Coroutine based Co-simulation TestBench) 是一个基于 Python 的验证框架，用于编写 VHDL 和 Verilog/SystemVerilog 的测试平台。

### 核心优势

1. **Python编写** - 使用熟悉的 Python 语言
2. **开源免费** - 无需商业仿真器许可
3. **协程驱动** - 基于异步编程模型
4. **多仿真器支持** - Icarus Verilog, Verilator, ModelSim 等

## 安装

```bash
# 基础安装（本项目锁定 cocotb 2.0.1，即 2.x API）
pip install --user --upgrade "cocotb==2.0.1"

# 覆盖率支持
pip install cocotb-coverage

# 约束随机化
pip install pyvsc
```

## 快速开始

### 1. 项目结构

```
my_project/
├── rtl/
│   └── counter.v        # DUT
├── tb/
│   └── test_counter.py  # 测试文件
├── Makefile             # 构建脚本
└── README.md
```

### 2. DUT 示例 (counter.v)

```verilog
module counter #(
    parameter WIDTH = 8
)(
    input  wire             clk,
    input  wire             rst_n,
    input  wire             enable,
    output reg [WIDTH-1:0]  count
);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            count <= 0;
        else if (enable)
            count <= count + 1;
    end

endmodule
```

### 3. 测试文件 (test_counter.py)

```python
import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

@cocotb.test()
async def basic_test(dut):
    """基本计数器测试"""
    
    # 启动时钟 (10ns 周期)
    clock = Clock(dut.clk, 10, unit='ns')
    cocotb.start_soon(clock.start())

    # 复位
    dut.rst_n.value = 0
    dut.enable.value = 0
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.rst_n.value = 1

    # 验证复位值
    assert dut.count.value == 0, "Reset failed"

    # 启用计数
    dut.enable.value = 1

    # 计数并验证
    for i in range(10):
        await RisingEdge(dut.clk)
        assert dut.count.value == i + 1, f"Count mismatch at {i+1}"

    print("Test passed!")

@cocotb.test()
async def reset_test(dut):
    """复位测试"""
    clock = Clock(dut.clk, 10, unit='ns')
    cocotb.start_soon(clock.start())
    
    # 复位
    dut.rst_n.value = 0
    await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    
    # 计数几个周期
    dut.enable.value = 1
    for _ in range(5):
        await RisingEdge(dut.clk)
    
    # 复位验证
    dut.rst_n.value = 0
    await RisingEdge(dut.clk)
    assert dut.count.value == 0, "Reset failed during counting"
```

### 4. Makefile

```makefile
SIM ?= icarus
TOPLEVEL_LANG = verilog

VERILOG_SOURCES = $(PWD)/rtl/counter.v
TOPLEVEL = counter
MODULE = test_counter

include $(shell cocotb-config --makefiles)/Makefile.sim
```

### 5. 运行测试

```bash
# 运行所有测试
make SIM=icarus

# 运行特定测试
MODULE=test_counter TESTCASE=basic_test make

# 清理
make clean
```

## 核心概念

### Triggers (触发器)

Cocotb 使用触发器来同步仿真时间：

```python
from cocotb.triggers import (
    RisingEdge,     # 上升沿
    FallingEdge,    # 下降沿
    ClockCycles,    # 时钟周期数
    Timer,          # 时间延时
    ReadOnly,       # 只读阶段
    NextTimeStep,   # 下一个时间步
    Combine,        # 组合多个触发器
    First,          # 第一个完成的触发器
    Event,          # 事件
    Lock,           # 锁
)

# 示例
await RisingEdge(dut.clk)           # 等待时钟上升沿
await FallingEdge(dut.rst_n)        # 等待复位下降沿
await ClockCycles(dut.clk, 10)      # 等待10个时钟周期
await Timer(100, unit='ns')        # 等待100ns

# 组合使用
await First(RisingEdge(dut.clk), Timer(1000, 'ns'))  # 先到的触发
```

### Clock (时钟)

```python
from cocotb.clock import Clock

# 创建并启动时钟
clock = Clock(dut.clk, 10, unit='ns')  # 10ns 周期 = 100MHz
cocotb.start_soon(clock.start())

# 或者使用 start
await cocotb.start(Clock(dut.clk, 10, 'ns').start())
```

### 访问 DUT 信号

```python
# 直接访问
value = dut.signal_name.value

# 层次化访问
value = dut.module.submodule.signal.value

# 使用 _id 访问动态路径
value = dut._id("path.to.signal", False).value

# 设置值
dut.signal_name.value = 1
dut.signal_name.value = 0xFF
dut.signal_name.value = BinaryValue('1010')

# 位向量操作
value = int(dut.data_bus.value)      # 转为整数
value = str(dut.data_bus.value)      # 转为二进制字符串
```

### 并发任务

```python
# 启动并发任务（推荐 start_soon）
cocotb.start_soon(my_coroutine1())
cocotb.start_soon(my_coroutine2())

# 需要等待结果时使用 start
task = await cocotb.start(my_coroutine())
await task
```

## 测试装饰器

```python
import cocotb

@cocotb.test(
    expect_error=Exception,           # 预期的错误
    skip=False,                        # 是否跳过
    stage=0,                           # 测试阶段
    timeout_time=1000,                 # 超时时间
    timeout_unit='us'                  # 超时单位
)
async def my_test(dut):
    pass

# 跳过测试
@cocotb.test(skip=True)
async def skipped_test(dut):
    pass

# 预期失败
@cocotb.test(expect_error=AssertionError)
async def expected_fail_test(dut):
    assert False  # 这会被预期
```

## 结果处理

cocotb 2.x 已移除 `cocotb.result` 模块（TestSuccess/TestFailure/TestError/SimFailure）。
测试通过时自然返回即可，失败时使用 `assert` 抛出 AssertionError：

```python
@cocotb.test()
async def my_test(dut):
    assert some_condition, "Something went wrong"
    # 测试通过：函数自然返回即视为成功，无需显式声明
```

## 断言

```python
# 使用 Python assert
assert dut.count.value == expected, f"Count mismatch: {dut.count.value} != {expected}"

# 使用 log
dut._log.info("Info message")
dut._log.warning("Warning message")
dut._log.error("Error message")
```

## 最佳实践

### 1. 使用环境类封装

```python
class TestEnvironment:
    def __init__(self, dut):
        self.dut = dut
        self.driver = MyDriver(dut)
        self.monitor = MyMonitor(dut)
        self.scoreboard = MyScoreboard()
    
    async def reset(self):
        self.dut.rst_n.value = 0
        await ClockCycles(self.dut.clk, 10)
        self.dut.rst_n.value = 1
        await ClockCycles(self.dut.clk, 5)
    
    async def run(self):
        cocotb.start_soon(self.monitor.run())

@cocotb.test()
async def test_with_env(dut):
    env = TestEnvironment(dut)
    await env.reset()
    await env.run()
```

### 2. 使用参数化测试

```python
import cocotb
from cocotb.parameterize import parameterize

@parameterize(
    ('data_width', [8, 16, 32]),
    ('addr_width', [16, 32])
)
@cocotb.test()
async def parameterized_test(dut, data_width, addr_width):
    pass
```

### 3. 使用工厂模式

```python
def create_transaction(addr, data, write):
    return {
        'addr': addr,
        'data': data,
        'write': write
    }

class TransactionFactory:
    @staticmethod
    def create_read(addr):
        return create_transaction(addr, 0, False)
    
    @staticmethod
    def create_write(addr, data):
        return create_transaction(addr, data, True)
```

## 调试技巧

### 1. 打印信号值

```python
print(f"Signal value: {dut.signal.value}")
dut._log.info(f"Signal: {dut.signal.value}")
```

### 2. 波形输出

```makefile
# 在 Makefile 中添加
EXTRA_ARGS += -DWAVEFORM
```

### 3. 使用 Python 调试器

```python
import pdb; pdb.set_trace()
```

## 常见问题

### Q: 仿真卡住不结束

检查是否所有 fork 的任务都正常结束，添加超时：

```python
@cocotb.test(timeout_time=1000, timeout_unit='us')
async def my_test(dut):
    pass
```

### Q: 无法访问某些信号

```python
# 检查信号是否存在
if hasattr(dut, 'signal_name'):
    value = dut.signal_name.value
```

### Q: 时钟未启动

确保在测试开始时启动时钟：

```python
clock = Clock(dut.clk, 10, 'ns')
cocotb.start_soon(clock.start())
```

## 参考链接

- [Cocotb 官方文档](https://docs.cocotb.org/)
- [Cocotb GitHub](https://github.com/cocotb/cocotb)
- [Cocotb 示例](https://github.com/cocotb/cocotb/tree/master/examples)