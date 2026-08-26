# MoonGlass 内置工具链

Windows Release 构建前运行 `pnpm stage:aigv-runtime`，生成单文件 `windows-x64/moonglass-aigv-runtime.tgz`。

归档包含 AIGV/Formal 所需的 Slang、Yosys、SymbiYosys、Yosys-SMTBMC、Boolector、Bitwuzla、运行依赖与许可证。归档不提交到源码仓库，由发布构建机从已安装的官方 OSS CAD Suite 生成并随安装包分发。
