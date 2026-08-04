# AXI-Lite Timer 最小验证计划

## Smoke 用例

| 用例 | 目标 | 通过条件 |
|------|------|----------|
| `basic_expire_irq` | 验证 `LOAD`、`CTRL.enable` 与 `CTRL.irq_enable` | 在有限周期内观察到 `timer_irq=1` |
| `w1c_status_clear` | 验证 `STATUS.expired` W1C 清除行为 | 写 `STATUS[0]=1` 后 `timer_irq` 拉低 |
| `auto_reload_second_irq` | 验证 auto-reload 路径 | 清第一次中断后再次观察到中断 |
| `stop_and_clear` | 验证停止与清状态组合 | `CTRL=0` 且清状态后中断保持为 0 |

## 质量证据

运行 `pnpm smoke:axi-lite-timer` 后，脚本会生成：

- lint 引擎、错误数、警告数。
- Icarus compile log。
- simulation log。
- `axi_lite_timer.vcd`。
- `result.json`。

这些证据后续可由 Web 流程看板采集并绑定到 RTL/VERIF/QA 阶段。
