# AXI-Lite Timer

`axi_lite_timer` 是 MoonGlass 内置 IP 模板库的第一个真实样例，用来验证「模板导入 → RTL lint → testbench 仿真 → 质量证据归档」这条闭环。

## 文件

| 路径 | 说明 |
|------|------|
| `rtl/axi_lite_timer.sv` | 32-bit AXI-Lite 定时器 RTL |
| `verification/tb_axi_lite_timer.sv` | Icarus/Verilator 友好的 smoke testbench |
| `docs/register-map.md` | 寄存器说明 |
| `docs/verification-plan.md` | 最小验证计划 |

## 行为摘要

- AXI-Lite 单拍写入要求 `AWVALID` 与 `WVALID` 同时保持到握手完成。
- `CTRL.enable` 拉高后从 `LOAD` 装载倒计数值。
- 倒计数到 0 后置位 `STATUS.expired`，并在 `CTRL.irq_enable=1` 时拉高 `timer_irq`。
- `STATUS.expired` 是 W1C 位，写 1 清除。
- `CTRL.auto_reload=1` 时到期后自动重新装载 `LOAD`。

## 本地验证

```bash
pnpm smoke:axi-lite-timer
```

该脚本会调用现有 `@moonglass/eda-bridge` 跑 lint，并使用 Icarus Verilog 编译执行 testbench，输出仿真日志、VCD 和 `result.json`。
