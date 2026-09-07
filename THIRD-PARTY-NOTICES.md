# 第三方组件说明

MoonGlass 使用 Electron、React、TanStack Router、Tailwind CSS、Pi Coding Agent、better-sqlite3、Drizzle ORM、PrismJS、Lucide 等第三方组件，并可调用用户安装或配置的 LLM 服务、EDA 工具、IP 与 PDK。

这些组件、模型服务和工具不因 MoonGlass 的许可证而改变其各自授权条件。发布二进制包时，应同时保留打包依赖自带的许可证与 notice 文件；用户在商业项目中使用外部模型、IP、PDK 或 EDA 工具前，应单独确认其许可范围。

MoonGlass 第一方代码为独立实现。对第三方名称的引用仅用于说明依赖、兼容性或许可证边界，不表示背书、合作或商标授权。

## 内置 AIGV 开源工具链

Windows 发布包可包含由 MoonGlass 裁剪和封装的 AIGV 运行时，用于语法结构分析与 Formal 验证。运行时保留各项目许可证文件，组件包括：

- Slang（MIT License）：SystemVerilog 编译前端与 AST 分析。
- Yosys（ISC License）：RTL 综合与 Formal 中间表示转换。
- SymbiYosys（ISC License）：Formal 任务编排。
- Boolector（MIT License）：SMT 求解器。
- Bitwuzla（MIT License）：SMT 求解器。

MoonGlass 仅进行再分发和调用，不改变这些项目各自的许可证、版权及商标归属。
