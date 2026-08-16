# 存储宏库

MoonGlass 内置参数化 SRAM 行为模型和宏视图生成器，用于在尚未取得 Memory Compiler 仿真模型时保持 RTL 与验证流程可运行。

生成器只创建功能仿真模型、综合 blackbox、固定尺寸 wrapper 和 manifest，不生成 Liberty/LEF/GDS，也不会把估算数据伪装成工艺签核数据。

入口：`sram_macro_generator/scripts/generate_sram_views.py`。
