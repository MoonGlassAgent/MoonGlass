# SYNTH-D2 判定实验记录（2026-09-29）

> 对应 `moonglass_defect_submission_pack.md` 的 SYNTH-D2（待定假设）：
> "全设计 synth 在 ALUMACC 阶段无错误信息中断，日志内嵌 GBK 破坏的绝对路径（假设，未证实）"。
> 交流_20260911.txt 决议："synthesis.ts 相对路径改造后请在纯 ASCII 路径复测判定"。

## 实验环境

- 机器：Windows，**系统代码页 936（GBK）**（`chcp` 实测），与 case2 用户环境同源。
- 工具链：OSS CAD Suite（yosys 0.67+84，git e2c27aaaf；mingw 构建），PATH 已按
  `tool-runner.ts` 的隔离口径净化（oss-cad-suite bin/lib 前置，移除 Strawberry Perl 等 MinGW 目录）。
- 激励 RTL（含 `$sub`/`$lt`，必触发 ALUMACC → ABC 链路）：

```verilog
module top(input [7:0] a, input [7:0] b, output [7:0] d, output lt);
  assign d = a - b;
  assign lt = (a < b);
endmodule
```

- 实验原始日志：`out/synth-d2-exp/`（exp1–exp5）。

## 实验矩阵与结果

| # | 场景 | 结果 | 关键证据 |
|---|------|------|----------|
| 1 | ASCII cwd + 相对路径（修复后口径的基线） | ✅ PASS, exit=0 | 跑完 ABC 与 stat |
| 2 | **中文路径 cwd + 相对路径**（修复后口径） | ✅ PASS, exit=0 | **logfile hash 与实验 1 逐字节一致**（9c1ed8139d） |
| 3 | 中文绝对路径经 argv 传入（`-p "read_verilog D:/.../中文路径/alu.v"`） | ✅ PASS, exit=0 | GBK 代码页下 argv 宽字符→ANSI 转换无损 |
| 4 | `.ys` 脚本内嵌 **UTF-8** 编码的中文绝对路径 | ❌ FAIL, exit=1 | `ERROR: File '...中文路径/alu.v' not found`——**显式报错**，非无声中断 |
| 5 | **临时移除 yosys-abc.exe**（模拟 SYNTH-D1），纯 ASCII 路径 | ❌ FAIL, exit=1 | 见下 |

实验 5 日志尾部（决定性证据）：

```
2.22. Executing ABC pass (technology mapping using ABC).
2.22.1. Extracting gate netlist of module `\top' to `<abc-temp-dir>/input.blif'..
Running ABC script: <abc-temp-dir>/abc.script
ABC: '<yosys-exe-dir>/yosys-abc' ڲⲿҲǿеĳ   ← cmd 的 GBK 错误消息混入日志
ABC: ļ
ERROR: ABC: execution of script "C:\Users\Allarum\AppData\Local\Temp\\yosys-abc-yJvkKk/abc.script" failed
```

（实验后已恢复 yosys-abc.exe 并验证存在。）

## 结论

1. **SYNTH-D2 的"路径编码同源"假设证伪。** 修复后口径（相对路径 + cwd，非 ASCII 只经 cwd 宽字符传递）
   在中文路径下综合完全正常，产物与纯 ASCII 基线逐字节一致（实验 1 vs 2）。
2. **真凶即 SYNTH-D1（yosys-abc.exe 漏打包），两案实为同一缺陷。** 时序吻合：ABC 恰是 `synth`
   流程中 ALUMACC/OPT 之后的下一阶段；abc 可执行缺失时，Windows cmd 的 GBK 错误消息
   （"不是内部或外部命令"）混入 yosys 日志，日志尾部即停在 ALUMACC 之后的 ABC 处——
   在 UTF-8 阅读器里呈现为"ALUMACC 阶段后中断 + 日志内嵌 GBK 破坏的文本"，与 case2 记录的现象逐字吻合。
3. **残留的独立路径风险只有一种形态**：把 UTF-8 编码的非 ASCII 绝对路径写进 `.ys`/`.mk` 等文本
   供 mingw 工具按 ANSI(GBK) 解读（实验 4）。但它产生**显式 File-not-found 错误**（fail-loud），
   且 `synthesis.ts:336-340,374-378` 的相对路径改造已封死该入口。
4. 后续防护已由 T6 用户侧环境自检覆盖：yosys 自检项包含 ABC 阶段
   （`synth -top` 全流程），yosys-abc 缺失类问题在安装后/自检时即暴露，不再流入综合阶段。

**判定：SYNTH-D2 闭环，归因 SYNTH-D1；无需额外代码改动。**
