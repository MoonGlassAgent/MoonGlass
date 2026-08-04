# AXI-Lite Timer 寄存器说明

基地址由集成方分配，模块内部使用 6-bit byte address。

| Offset | 名称 | 方向 | 位域 | 复位值 | 说明 |
|--------|------|------|------|--------|------|
| `0x00` | `CTRL` | RW | `[0] enable` | `0` | 写 1 启动定时器，写 0 停止 |
| `0x00` | `CTRL` | RW | `[1] auto_reload` | `0` | 到期后自动重新装载 `LOAD` |
| `0x00` | `CTRL` | RW | `[2] irq_enable` | `0` | 允许 `STATUS.expired` 驱动 `timer_irq` |
| `0x04` | `PRESCALE` | RW | `[31:0] prescale` | `0` | 每 `prescale + 1` 个 clock 产生一次 timer tick |
| `0x08` | `LOAD` | RW | `[31:0] load_value` | `1000` | 倒计数装载值，写入时同步更新当前计数 |
| `0x0C` | `VALUE` | RO | `[31:0] timer_value` | `0` | 当前倒计数值 |
| `0x10` | `STATUS` | W1C/RO | `[0] expired` | `0` | 到期状态位，写 1 清除 |

未定义地址读回 `0`，写入无副作用，响应均为 `OKAY`。
