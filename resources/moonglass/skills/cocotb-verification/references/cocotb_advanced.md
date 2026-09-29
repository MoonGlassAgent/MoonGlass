# Cocotb 高级特性

## 高级触发器使用

### 自定义触发器

```python
from cocotb.triggers import Trigger, Event
import cocotb

class WaitForValue(Trigger):
    """等待信号达到特定值的触发器"""
    
    def __init__(self, signal, target_value):
        self.signal = signal
        self.target_value = target_value
        super().__init__()
    
    def _prime(self, callback):
        self._callback = callback
        self._check()
    
    def _check(self):
        if int(self.signal.value) == self.target_value:
            self._callback()
        else:
            cocotb.simulator._register_read_only_callback(self._check)

# 使用
await WaitForValue(dut.status, 0x01)
```

### 复合触发器

```python
from cocotb.triggers import RisingEdge, Timer, First, Combine

# 等待任一触发器
result = await First(
    RisingEdge(dut.valid),
    Timer(1000, 'ns')
)
if isinstance(result, Timer):
    print("Timeout!")

# 等待所有触发器
await Combine(
    RisingEdge(dut.clk),
    RisingEdge(dut.valid)
)
```

## 高级时钟管理

### 多时钟域

```python
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

@cocotb.test()
async def multi_clock_test(dut):
    # 启动多个时钟
    clk_a = Clock(dut.clk_a, 10, 'ns')   # 100 MHz
    clk_b = Clock(dut.clk_b, 20, 'ns')   # 50 MHz
    
    cocotb.start_soon(clk_a.start())
    cocotb.start_soon(clk_b.start())
    
    # 跨时钟域等待
    await RisingEdge(dut.clk_a)
    # 在 clk_a 域操作
    dut.data_a.value = 0x1234
    
    await RisingEdge(dut.clk_b)
    # 在 clk_b 域操作
    dut.data_b.value = 0x5678
```

### 时钟相位控制

```python
from cocotb.clock import Clock

# 创建有相位差的时钟
async def create_phase_shifted_clocks(dut):
    # 主时钟
    cocotb.start_soon(Clock(dut.clk0, 10, 'ns').start())
    
    # 等待相位偏移
    await Timer(2.5, 'ns')
    
    # 90度相位时钟
    cocotb.start_soon(Clock(dut.clk90, 10, 'ns').start())
```

## 高级驱动器模式

### 可重用驱动器基类

```python
from cocotb.triggers import RisingEdge, Event
from typing import List, Callable
import logging

class BaseDriver:
    """可重用的驱动器基类"""
    
    def __init__(self, dut, name: str, clk_signal):
        self.dut = dut
        self.name = name
        self.log = logging.getLogger(f"cocotb.{name}")
        self.clk = clk_signal
        self.queue = []
        self._idle = Event()
        self._idle.set()
        self.callbacks = []
    
    def append(self, item):
        """添加事务到队列"""
        self.queue.append(item)
        self._idle.clear()
    
    async def send(self, item):
        """发送单个事务"""
        self.append(item)
        await self._idle.wait()
    
    async def drive(self, item):
        """驱动事务 - 子类实现"""
        raise NotImplementedError
    
    async def run(self):
        """主循环"""
        while True:
            if self.queue:
                item = self.queue.pop(0)
                await self.drive(item)
                for cb in self.callbacks:
                    cb(item)
                if not self.queue:
                    self._idle.set()
            await RisingEdge(self.clk)
    
    def add_callback(self, callback: Callable):
        self.callbacks.append(callback)
```

### 批量事务处理

```python
class BatchDriver(BaseDriver):
    """支持批量事务的驱动器"""
    
    def __init__(self, dut, name, clk):
        super().__init__(dut, name, clk)
        self.batch_size = 16
    
    async def send_batch(self, items: List):
        """发送批量事务"""
        for i in range(0, len(items), self.batch_size):
            batch = items[i:i+self.batch_size]
            for item in batch:
                self.append(item)
            await self._idle.wait()
```

## 高级监控器模式

### 带过滤的监控器

```python
class FilteredMonitor:
    """带过滤功能的监控器"""
    
    def __init__(self, dut, name, clk, filter_fn=None):
        self.dut = dut
        self.name = name
        self.clk = clk
        self.filter_fn = filter_fn or (lambda x: True)
        self.transactions = []
        self.callbacks = []
    
    def add_callback(self, callback):
        self.callbacks.append(callback)
    
    async def capture(self):
        """捕获事务 - 子类实现"""
        raise NotImplementedError
    
    async def run(self):
        while True:
            await RisingEdge(self.clk)
            trans = await self.capture()
            if trans and self.filter_fn(trans):
                self.transactions.append(trans)
                for cb in self.callbacks:
                    cb(trans)
```

### 统计监控器

```python
class StatisticsMonitor(FilteredMonitor):
    """带统计功能的监控器"""
    
    def __init__(self, dut, name, clk, filter_fn=None):
        super().__init__(dut, name, clk, filter_fn)
        self.stats = {
            'total': 0,
            'reads': 0,
            'writes': 0,
            'errors': 0
        }
    
    async def run(self):
        while True:
            await RisingEdge(self.clk)
            trans = await self.capture()
            if trans:
                self.stats['total'] += 1
                if hasattr(trans, 'write'):
                    if trans.write:
                        self.stats['writes'] += 1
                    else:
                        self.stats['reads'] += 1
                
                if self.filter_fn(trans):
                    self.transactions.append(trans)
                    for cb in self.callbacks:
                        cb(trans)
    
    def get_stats(self):
        return self.stats.copy()
```

## 约束随机化

### 使用 cocotb-coverage

```python
from cocotb_coverage import crv

class RandomTransaction(crv.Randomized):
    def __init__(self):
        super().__init__()
        
        # 随机变量
        self.addr = 0
        self.data = 0
        self.write = 0
        
        # 添加随机属性
        self.add_rand("addr", list(range(0, 256, 4)))
        self.add_rand("data", list(range(0, 0xFFFFFFFF, 1)))
        self.add_rand("write", [0, 1])
        
        # 添加约束
        # 地址必须4字节对齐
        self.add_constraint(lambda addr: addr % 4 == 0)
        # 写操作数据不能为0
        self.add_constraint(lambda write, data: write == 0 or data != 0)

# 使用
trans = RandomTransaction()
trans.randomize()
print(f"Random: addr=0x{trans.addr:x}, data=0x{trans.data:x}, write={trans.write}")
```

### 使用 pyvsc

```python
import vsc

@vsc.randobj
class RandomTransaction:
    def __init__(self):
        self.addr = vsc.rand_bit_t(32)
        self.data = vsc.rand_bit_t(32)
        self.write = vsc.rand_bit_t(1)
    
    @vsc.constraint
    def addr_aligned(self):
        vsc.constraint(self.addr % 4 == 0)
    
    @vsc.constraint
    def valid_write(self):
        with vsc.if_then(self.write == 1):
            vsc.constraint(self.data != 0)

# 使用
trans = RandomTransaction()
trans.randomize()
```

## 功能覆盖率

### 使用 cocotb-coverage

```python
from cocotb_coverage.coverage import CoverPoint, CoverCross, coverage_report

# 定义覆盖点
@CoverPoint("top.addr",
    vname="addr",
    bins=[
        (0x00, 0x3F),   # 低地址
        (0x40, 0x7F),   # 中地址
        (0x80, 0xBF),   # 高地址
        (0xC0, 0xFF),   # 顶地址
    ]
)
@CoverPoint("top.write",
    vname="write",
    bins=[0, 1]
)
@CoverCross("top.cross", items=["top.addr", "top.write"])
def sample_coverage(addr, write):
    pass

# 在测试中采样
sample_coverage(trans.addr, trans.write)

# 生成报告
coverage_report()
```

### 自定义覆盖率模型

```python
class CoverageModel:
    """自定义覆盖率模型"""
    
    def __init__(self, name):
        self.name = name
        self.bins = {}
        self.cross_bins = {}
        self.sample_count = 0
    
    def add_bin(self, bin_name, ranges):
        """添加覆盖仓"""
        self.bins[bin_name] = {
            'ranges': ranges,
            'hits': [0] * len(ranges)
        }
    
    def add_cross(self, cross_name, bin_names):
        """添加交叉覆盖"""
        self.cross_bins[cross_name] = {
            'bins': bin_names,
            'hits': {}
        }
    
    def sample(self, **values):
        """采样"""
        self.sample_count += 1
        
        # 采样单个覆盖点
        for bin_name, value in values.items():
            if bin_name in self.bins:
                for i, (min_v, max_v) in enumerate(self.bins[bin_name]['ranges']):
                    if min_v <= value <= max_v:
                        self.bins[bin_name]['hits'][i] += 1
                        break
        
        # 采样交叉覆盖
        for cross_name, cross_info in self.cross_bins.items():
            key = tuple(values.get(bn, 0) for bn in cross_info['bins'])
            cross_info['hits'][key] = cross_info['hits'].get(key, 0) + 1
    
    def get_coverage(self, bin_name=None):
        """获取覆盖率"""
        if bin_name:
            hits = sum(1 for h in self.bins[bin_name]['hits'] if h > 0)
            total = len(self.bins[bin_name]['hits'])
            return hits / total * 100 if total > 0 else 0
        
        total_coverage = 0
        for bn in self.bins:
            total_coverage += self.get_coverage(bn)
        return total_coverage / len(self.bins) if self.bins else 0
    
    def report(self):
        """生成报告"""
        print(f"\n=== {self.name} Coverage Report ===")
        print(f"Samples: {self.sample_count}")
        for bin_name, bin_info in self.bins.items():
            hits = sum(1 for h in bin_info['hits'] if h > 0)
            total = len(bin_info['hits'])
            coverage = hits / total * 100 if total > 0 else 0
            print(f"  {bin_name}: {coverage:.1f}% ({hits}/{total})")
```

## 寄存器模型

```python
class RegisterModel:
    """简化的寄存器模型"""
    
    def __init__(self, name):
        self.name = name
        self.registers = {}
        self.callbacks = {}
    
    def add_register(self, addr, name, reset_value=0, access='rw'):
        """添加寄存器"""
        self.registers[addr] = {
            'name': name,
            'value': reset_value,
            'reset_value': reset_value,
            'access': access
        }
    
    def write(self, addr, value):
        """写寄存器"""
        if addr in self.registers:
            reg = self.registers[addr]
            if 'w' in reg['access']:
                reg['value'] = value
                if addr in self.callbacks:
                    for cb in self.callbacks[addr]:
                        cb(reg['name'], value)
    
    def read(self, addr):
        """读寄存器"""
        if addr in self.registers:
            return self.registers[addr]['value']
        return None
    
    def add_callback(self, addr, callback):
        """添加寄存器回调"""
        if addr not in self.callbacks:
            self.callbacks[addr] = []
        self.callbacks[addr].append(callback)
    
    def reset(self):
        """复位所有寄存器"""
        for addr, reg in self.registers.items():
            reg['value'] = reg['reset_value']
```

### 配置序列 → 业务流量范式（TOP 优先）

这类 IP 的业务/corner 场景本质是配置寄存器组合：testcase 一律面向
TOP，激励分两段——先经总线 VIP 下发**配置序列**，再发送**业务流量**并
检查外部可观察行为。

```python
@cocotb.test(timeout_time=200, timeout_unit="us")
async def config_then_traffic_test(dut):
    env = TopEnv(dut)
    env.start_clock()
    await env.reset()
    await env.run()

    # 1. 配置序列：经总线 VIP 编程配置寄存器
    await env.bus.write_reg(REG_CFG_MODE, MODE_RUN)      # enum 字段
    await env.bus.write_reg(REG_CFG_THRESH, THRESH_MAX)  # range 字段边界
    await env.bus.write_reg(REG_CFG_EN, 1)               # flag 字段

    # 2. 业务流量：在配置上下文下发激励
    await env.send_transactions(make_traffic(count=20))
    await env.wait_idle()

    # 3. 判定：scoreboard 比对 + 配置覆盖埋点已随序列自动记录
    assert env.get_result()
    env.report()  # report() 结束时会写 config-coverage.json（若存在 config-space）
```

配置覆盖埋点由生成的环境承担：每次寄存器写入自动按
`verification/intelligence/config-space.json` 记桶（enum 每值一桶；range
分 0/min/典型/max 四桶；flag 两桶），constraints 涉及的字段对自动记
cross；仿真结束写入
`verification/results/<topModule>/config-coverage.json` 并跨回归累积
（启动时读旧文件合并 hits，结束写回）。账本不存在时环境跳过埋点，
禁止编造寄存器；非法配置组合必须校验 DUT 行为符合规格期望（报错/
忽略/截断），不得把非法激励当 PASS 放行。

## 断言助手

```python
from cocotb.triggers import RisingEdge, Timer

async def assert_signal(dut, signal_path, expected, timeout_cycles=100, clk=None):
    """断言信号值"""
    signal = dut._id(signal_path, False)
    
    for _ in range(timeout_cycles):
        if int(signal.value) == expected:
            return True
        if clk:
            await RisingEdge(clk)
        else:
            await Timer(1, 'ns')
    
    raise AssertionError(
        f"Signal {signal_path} != {expected} after {timeout_cycles} cycles "
        f"(actual: {signal.value})"
    )

async def wait_for_signal(dut, signal_path, timeout_cycles=100, clk=None):
    """等待信号变高"""
    signal = dut._id(signal_path, False)
    
    for _ in range(timeout_cycles):
        if int(signal.value) == 1:
            return
        if clk:
            await RisingEdge(clk)
        else:
            await Timer(1, 'ns')
    
    raise TimeoutError(f"Signal {signal_path} timeout after {timeout_cycles} cycles")

async def wait_for_edge(dut, signal_path, edge='rising', timeout_cycles=100, clk=None):
    """等待信号边沿"""
    signal = dut._id(signal_path, False)
    prev = int(signal.value)
    
    for _ in range(timeout_cycles):
        curr = int(signal.value)
        if edge == 'rising' and prev == 0 and curr == 1:
            return
        if edge == 'falling' and prev == 1 and curr == 0:
            return
        prev = curr
        if clk:
            await RisingEdge(clk)
        else:
            await Timer(1, 'ns')
    
    raise TimeoutError(f"Signal {signal_path} edge timeout")
```

## 性能优化

### 减少上下文切换

```python
# 批量操作
async def efficient_batch(dut, items):
    for item in items:
        dut.data.value = item
        await RisingEdge(dut.clk)

# 而不是
async def inefficient_batch(dut, items):
    for item in items:
        await send_single_item(dut, item)  # 每次都有额外开销
```

### 使用 ReadOnly 阶段

```python
from cocotb.triggers import ReadOnly

async def capture_after_delay(dut):
    await ReadOnly()  # 在 delta cycle 结束后捕获
    return int(dut.signal.value)
```

## 参考链接

- [Cocotb Coverage](https://github.com/mciepluc/cocotb-coverage)
- [pyvsc](https://github.com/fvutils/pyvsc)
- [Cocotb Extensions](https://docs.cocotb.org/en/stable/extensions.html)