# Cocotb 测试示例集

## 示例 1: 简单计数器验证

### DUT (counter.v)

```verilog
module counter #(
    parameter WIDTH = 8
)(
    input  wire             clk,
    input  wire             rst_n,
    input  wire             enable,
    input  wire             load,
    input  wire [WIDTH-1:0] load_data,
    output reg  [WIDTH-1:0] count,
    output wire             overflow
);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            count <= 0;
        else if (load)
            count <= load_data;
        else if (enable)
            count <= count + 1;
    end

    assign overflow = (count == {WIDTH{1'b1}}) && enable;

endmodule
```

### 测试 (test_counter.py)

```python
import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, ClockCycles

class CounterEnv:
    def __init__(self, dut):
        self.dut = dut
    
    async def reset(self):
        self.dut.rst_n.value = 0
        self.dut.enable.value = 0
        self.dut.load.value = 0
        await ClockCycles(self.dut.clk, 5)
        self.dut.rst_n.value = 1
        await ClockCycles(self.dut.clk, 2)
    
    async def count_up(self, cycles):
        self.dut.enable.value = 1
        start = int(self.dut.count.value)
        for i in range(cycles):
            await RisingEdge(self.dut.clk)
            expected = (start + i + 1) & 0xFF
            actual = int(self.dut.count.value)
            assert actual == expected, f"Count error: expected {expected}, got {actual}"
    
    async def load_value(self, value):
        self.dut.enable.value = 0
        self.dut.load.value = 1
        self.dut.load_data.value = value
        await RisingEdge(self.dut.clk)
        self.dut.load.value = 0
        await RisingEdge(self.dut.clk)
        assert int(self.dut.count.value) == value

@cocotb.test()
async def test_reset(dut):
    """测试复位功能"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = CounterEnv(dut)
    await env.reset()
    
    assert int(dut.count.value) == 0, "Reset failed"
    print("Reset test passed!")

@cocotb.test()
async def test_count(dut):
    """测试计数功能"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = CounterEnv(dut)
    await env.reset()
    await env.count_up(100)
    print("Count test passed!")

@cocotb.test()
async def test_load(dut):
    """测试加载功能"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = CounterEnv(dut)
    await env.reset()
    
    test_values = [0x00, 0x55, 0xAA, 0xFF]
    for val in test_values:
        await env.load_value(val)
    
    print("Load test passed!")

@cocotb.test()
async def test_overflow(dut):
    """测试溢出"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = CounterEnv(dut)
    await env.reset()
    
    # 加载最大值
    await env.load_value(0xFF)
    
    # 计数一次触发溢出
    dut.enable.value = 1
    await RisingEdge(dut.clk)
    
    assert int(dut.overflow.value) == 1, "Overflow not detected"
    print("Overflow test passed!")
```

---

## 示例 2: FIFO 验证

### DUT (sync_fifo.v)

```verilog
module sync_fifo #(
    parameter DATA_WIDTH = 8,
    parameter DEPTH = 16
)(
    input  wire                   clk,
    input  wire                   rst_n,
    input  wire [DATA_WIDTH-1:0]  wr_data,
    input  wire                   wr_en,
    output wire                   full,
    input  wire                   rd_en,
    output wire [DATA_WIDTH-1:0]  rd_data,
    output wire                   empty
);

    localparam ADDR_WIDTH = $clog2(DEPTH);
    
    reg [DATA_WIDTH-1:0] mem [0:DEPTH-1];
    reg [ADDR_WIDTH:0]   wr_ptr;
    reg [ADDR_WIDTH:0]   rd_ptr;
    
    wire wr_valid = wr_en && !full;
    wire rd_valid = rd_en && !empty;
    
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr <= 0;
            rd_ptr <= 0;
        end else begin
            if (wr_valid) begin
                mem[wr_ptr[ADDR_WIDTH-1:0]] <= wr_data;
                wr_ptr <= wr_ptr + 1;
            end
            if (rd_valid)
                rd_ptr <= rd_ptr + 1;
        end
    end
    
    assign full  = (wr_ptr[ADDR_WIDTH] != rd_ptr[ADDR_WIDTH]) && 
                   (wr_ptr[ADDR_WIDTH-1:0] == rd_ptr[ADDR_WIDTH-1:0]);
    assign empty = (wr_ptr == rd_ptr);
    assign rd_data = mem[rd_ptr[ADDR_WIDTH-1:0]];

endmodule
```

### 测试 (test_fifo.py)

```python
import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, FallingEdge
from collections import deque
import random

class FIFOEnv:
    def __init__(self, dut):
        self.dut = dut
        self.expected = deque()
        self.errors = 0
    
    async def reset(self):
        self.dut.rst_n.value = 0
        self.dut.wr_en.value = 0
        self.dut.rd_en.value = 0
        for _ in range(10):
            await RisingEdge(self.dut.clk)
        self.dut.rst_n.value = 1
        for _ in range(2):
            await RisingEdge(self.dut.clk)
    
    async def write(self, data):
        """写入数据"""
        while self.dut.full.value:
            await RisingEdge(self.dut.clk)
        
        self.dut.wr_data.value = data
        self.dut.wr_en.value = 1
        self.expected.append(data)
        await RisingEdge(self.dut.clk)
        self.dut.wr_en.value = 0
    
    async def read(self):
        """读取数据"""
        while self.dut.empty.value:
            await RisingEdge(self.dut.clk)
        
        self.dut.rd_en.value = 1
        await RisingEdge(self.dut.clk)
        self.dut.rd_en.value = 0
        
        actual = int(self.dut.rd_data.value)
        expected = self.expected.popleft()
        
        if actual != expected:
            self.errors += 1
            print(f"Mismatch: expected 0x{expected:02X}, got 0x{actual:02X}")
        
        return actual
    
    async def write_burst(self, data_list):
        for d in data_list:
            await self.write(d)
    
    async def read_burst(self, count):
        data = []
        for _ in range(count):
            d = await self.read()
            data.append(d)
        return data

@cocotb.test()
async def test_basic_write_read(dut):
    """基本读写测试"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = FIFOEnv(dut)
    await env.reset()
    
    # 写入数据
    test_data = [0x11, 0x22, 0x33, 0x44]
    for d in test_data:
        await env.write(d)
    
    # 读取并验证
    for expected in test_data:
        actual = await env.read()
        assert actual == expected, f"Data mismatch: {actual} != {expected}"
    
    assert env.errors == 0, f"Found {env.errors} errors"
    print("Basic write/read test passed!")

@cocotb.test()
async def test_full_empty(dut):
    """满空标志测试"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = FIFOEnv(dut)
    await env.reset()
    
    # 检查初始为空
    assert dut.empty.value == 1, "FIFO should be empty after reset"
    assert dut.full.value == 0, "FIFO should not be full after reset"
    
    # 填满FIFO
    for i in range(16):
        await env.write(i)
    
    assert dut.full.value == 1, "FIFO should be full"
    
    # 读空FIFO
    for i in range(16):
        await env.read()
    
    assert dut.empty.value == 1, "FIFO should be empty"
    print("Full/Empty test passed!")

@cocotb.test()
async def test_random(dut):
    """随机读写测试"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = FIFOEnv(dut)
    await env.reset()
    
    total_writes = 100
    write_count = 0
    read_count = 0
    
    while write_count < total_writes or read_count < total_writes:
        # 随机选择操作
        if write_count < total_writes and (random.random() < 0.5 or dut.empty.value):
            data = random.randint(0, 255)
            await env.write(data)
            write_count += 1
        elif read_count < total_writes and not dut.empty.value:
            await env.read()
            read_count += 1
        else:
            await RisingEdge(dut.clk)
    
    assert env.errors == 0, f"Found {env.errors} errors"
    print("Random test passed!")
```

---

## 示例 3: 状态机验证

### DUT (traffic_light.v)

```verilog
module traffic_light (
    input  wire clk,
    input  wire rst_n,
    input  wire emergency,
    output reg  [1:0] light,  // 00=RED, 01=GREEN, 10=YELLOW
    output reg  [7:0] timer
);

    localparam RED    = 2'b00;
    localparam GREEN  = 2'b01;
    localparam YELLOW = 2'b10;
    
    localparam RED_TIME    = 30;
    localparam GREEN_TIME  = 25;
    localparam YELLOW_TIME = 5;
    
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            light <= RED;
            timer <= RED_TIME;
        end else if (emergency) begin
            light <= RED;
            timer <= RED_TIME;
        end else if (timer == 0) begin
            case (light)
                RED:    begin light <= GREEN;  timer <= GREEN_TIME;  end
                GREEN:  begin light <= YELLOW; timer <= YELLOW_TIME; end
                YELLOW: begin light <= RED;    timer <= RED_TIME;    end
                default: begin light <= RED;   timer <= RED_TIME;    end
            endcase
        end else begin
            timer <= timer - 1;
        end
    end

endmodule
```

### 测试 (test_traffic_light.py)

```python
import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, ClockCycles

RED = 0
GREEN = 1
YELLOW = 2

class TrafficLightEnv:
    def __init__(self, dut):
        self.dut = dut
    
    async def reset(self):
        self.dut.rst_n.value = 0
        self.dut.emergency.value = 0
        await ClockCycles(self.dut.clk, 5)
        self.dut.rst_n.value = 1
        await ClockCycles(self.dut.clk, 2)
    
    async def wait_for_state_change(self, timeout=100):
        current = int(self.dut.light.value)
        for _ in range(timeout):
            await RisingEdge(self.dut.clk)
            if int(self.dut.light.value) != current:
                return int(self.dut.light.value)
        return None
    
    async def trigger_emergency(self):
        self.dut.emergency.value = 1
        await RisingEdge(self.dut.clk)
        self.dut.emergency.value = 0

@cocotb.test()
async def test_state_sequence(dut):
    """测试状态序列: RED -> GREEN -> YELLOW -> RED"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = TrafficLightEnv(dut)
    await env.reset()
    
    # 验证初始状态
    assert int(dut.light.value) == RED, "Should start in RED"
    
    # 验证状态转换序列
    expected_sequence = [GREEN, YELLOW, RED, GREEN]
    
    for expected in expected_sequence:
        actual = await env.wait_for_state_change(timeout=100)
        assert actual == expected, f"State mismatch: expected {expected}, got {actual}"
        print(f"Transition to {['RED', 'GREEN', 'YELLOW'][expected]}")
    
    print("State sequence test passed!")

@cocotb.test()
async def test_timer_values(dut):
    """测试计时器值"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = TrafficLightEnv(dut)
    await env.reset()
    
    expected_times = {
        RED: 30,
        GREEN: 25,
        YELLOW: 5
    }
    
    for _ in range(3):  # 测试3个周期
        current_state = int(dut.light.value)
        expected_time = expected_times[current_state]
        
        assert int(dut.timer.value) == expected_time, \
            f"Timer mismatch for state {current_state}"
        
        await env.wait_for_state_change()

@cocotb.test()
async def test_emergency(dut):
    """测试紧急模式"""
    clock = Clock(dut.clk, 10, 'ns')
    cocotb.start_soon(clock.start())
    
    env = TrafficLightEnv(dut)
    await env.reset()
    
    # 等待变绿
    await env.wait_for_state_change()
    assert int(dut.light.value) == GREEN
    
    # 触发紧急模式
    await env.trigger_emergency()
    
    # 应该立即变红
    await RisingEdge(dut.clk)
    assert int(dut.light.value) == RED, "Emergency should trigger RED light"
    
    print("Emergency test passed!")
```

---

## Makefile 模板

```makefile
SIM ?= icarus
TOPLEVEL_LANG = verilog

VERILOG_SOURCES = $(PWD)/../rtl/counter.v
TOPLEVEL = counter
MODULE = test_counter

include $(shell cocotb-config --makefiles)/Makefile.sim

test:
	@echo "Running tests..."
	$(MAKE) SIM=$(SIM)

clean::
	rm -rf results.xml dump.vcd __pycache__ *.pyc
```

## 运行示例

```bash
# 进入测试目录
cd examples/counter

# 运行测试
make SIM=icarus

# 查看结果
# 测试通过会显示 PASSED
```