# SRAM Macro Generator

## RFSP288X80M4LL 示例

```bash
python scripts/generate_sram_views.py \
  --macro-name RFSP288X80M4LL \
  --wrapper-name SRAMS288X80_CPU \
  --depth 288 \
  --width 80 \
  --output-dir rtl/macros/RFSP288X80M4LL
```

生成文件：

- `RFSP288X80M4LL_behavioral.v`：仅用于 RTL 仿真，低有效 `CEN/WEN`，同步一拍读。
- `RFSP288X80M4LL_blackbox.v`：仅供 Yosys `read_verilog -lib`。
- `SRAMS288X80_CPU.v`：固定 288×80 wrapper，把高有效 `ce/we` 转成低有效宏控制。
- `RFSP288X80M4LL.json`：尺寸、端口、行为假设和缺失工艺视图说明。

288 深度使用 9 位地址，地址 288–511 属于非法范围。默认非法读输出 `X`、非法写忽略并产生 warning。

生成器不能替代 Memory Compiler。真实 STA、面积、功耗和布局仍需要与该宏完全匹配的 Liberty/LEF/GDS。

